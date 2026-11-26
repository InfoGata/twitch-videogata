import ky from "ky";
import {
  MessageType,
  TokenResponse,
  TwitchChannel,
  TwitchChannelInformation,
  TwitchResponse,
  TwitchStream,
  TwitchUserInformation,
  TwitchVideo,
  UiMessageType,
} from "./types";
import { parse, toSeconds } from "iso8601-duration";

const getIdFromChannelName = async (channelName: string): Promise<string> => {
  const url = "https://api.twitch.tv/helix/users";
  const urlWithQuery = `${url}?login=${channelName}`;
  const response = await http.get<TwitchResponse<TwitchUserInformation>>(
    urlWithQuery
  ).json();
  return response.data[0].id;
};

// Holds the client secret, so the plugin can mint app tokens and exchange
// sign-in codes without ever seeing it.
export const TOKEN_SERVER =
  "https://cloudflare-worker-token-service.audio-pwa.workers.dev/token";
const CLIENT_ID = "19tpyf3jn7o7c05mk774ira19x8bbp";
const AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
const REVOKE_URL = "https://id.twitch.tv/oauth2/revoke";
/** Only what the followed-streams feed needs. */
const SCOPES = ["user:read:follows"];

const APP_TOKEN_KEY = "access_token";
const USER_TOKEN_KEY = "user_access_token";
const USER_REFRESH_KEY = "user_refresh_token";
const USER_ID_KEY = "user_id";
const LOGIN_NONCE_KEY = "login_nonce";

const isLoggedIn = (): boolean => !!localStorage.getItem(USER_TOKEN_KEY);

const clearUserTokens = () => {
  localStorage.removeItem(USER_TOKEN_KEY);
  localStorage.removeItem(USER_REFRESH_KEY);
  localStorage.removeItem(USER_ID_KEY);
};

/** The app page that relays the OAuth callback back to the host. */
const getRedirectUri = (): string => {
  // The plugin runs on <plugin id>.<app host>; the page is on the app host.
  // Bare localhost is the same-origin dev mode, already on the app host.
  const url = new URL(window.location.origin);
  if (url.hostname !== "localhost") {
    url.hostname = url.hostname.split(".").slice(1).join(".");
  }
  return `${url.origin}/login_popup.html`;
};

const requestToken = (params: URLSearchParams): Promise<Response> => {
  params.append("client_id", CLIENT_ID);
  // Plain fetch rather than http: the token server wants no Twitch headers,
  // and a 401 from it mustn't re-enter http's refresh hook.
  return fetch(TOKEN_SERVER, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
};

const fetchAppToken = async (): Promise<string> => {
  const params = new URLSearchParams({ grant_type: "client_credentials" });
  const response = await requestToken(params);
  if (!response.ok) {
    throw new Error(`Could not get a Twitch app token: ${response.status}`);
  }
  const result: TokenResponse = await response.json();
  localStorage.setItem(APP_TOKEN_KEY, result.access_token);
  return result.access_token;
};

/**
 * Trade the refresh token for a new user token. Resolves null when the
 * sign-in is gone for good (revoked, or the password changed), which signs
 * the user out; any other failure throws and keeps them signed in.
 */
const refreshUserToken = async (): Promise<string | null> => {
  const refreshToken = localStorage.getItem(USER_REFRESH_KEY);
  if (!refreshToken) {
    clearUserTokens();
    return null;
  }
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const response = await requestToken(params);
  if (response.status === 400 || response.status === 401) {
    clearUserTokens();
    return null;
  }
  if (!response.ok) {
    throw new Error(`Could not refresh the Twitch sign-in: ${response.status}`);
  }
  const result: TokenResponse = await response.json();
  localStorage.setItem(USER_TOKEN_KEY, result.access_token);
  if (result.refresh_token) {
    localStorage.setItem(USER_REFRESH_KEY, result.refresh_token);
  }
  return result.access_token;
};

/**
 * Concurrent requests that all hit an expired token share one refresh, so a
 * page of requests doesn't mint a page of tokens.
 */
let pendingToken: Promise<string | null> | undefined;
const renewToken = (): Promise<string | null> => {
  pendingToken ??= (
    isLoggedIn()
      ? refreshUserToken().then((token) => token ?? fetchAppToken())
      : fetchAppToken()
  ).finally(() => {
    pendingToken = undefined;
  });
  return pendingToken;
};

/** The signed-in user's token when there is one: Helix accepts it everywhere. */
const currentToken = (): string | null =>
  localStorage.getItem(USER_TOKEN_KEY) ?? localStorage.getItem(APP_TOKEN_KEY);

const http = ky.create({
  headers: {
    "Client-Id": CLIENT_ID,
  },
  hooks: {
    beforeRequest: [
      (request) => {
        const token = currentToken();
        if (token) {
          request.headers.set("Authorization", "Bearer " + token);
        }
      },
    ],
    afterResponse: [
      async (request, _options, response) => {
        if (response.status !== 401) return;
        const token = await renewToken();
        if (!token) return;
        // Plain ky, so a second 401 is returned rather than looping.
        const retry = new Request(request);
        retry.headers.set("Authorization", "Bearer " + token);
        return ky(retry, { retry: 0, throwHttpErrors: false });
      },
    ],
  },
});

/** Start the OAuth flow; the host opens the returned url in its popup. */
const login = async (): Promise<LoginResponse> => {
  const nonce = crypto.randomUUID();
  localStorage.setItem(LOGIN_NONCE_KEY, nonce);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.append("client_id", CLIENT_ID);
  url.searchParams.append("redirect_uri", getRedirectUri());
  url.searchParams.append("response_type", "code");
  url.searchParams.append("scope", SCOPES.join(" "));
  // pluginId routes the native apps' deep link back to this plugin; nonce
  // ties the callback to this sign-in.
  url.searchParams.append(
    "state",
    JSON.stringify({ pluginId: await application.getPluginId(), nonce })
  );
  return { url: url.toString() };
};

const loginFailed = (reason: string) => {
  application.createNotification({
    message: `Twitch sign-in failed: ${reason}`,
    type: "error",
  });
};

const loginCallback = async (request: LoginCallbackRequest): Promise<void> => {
  const callbackUrl = new URL(request.url);
  const params = callbackUrl.searchParams;
  const expectedNonce = localStorage.getItem(LOGIN_NONCE_KEY);
  localStorage.removeItem(LOGIN_NONCE_KEY);

  const error = params.get("error");
  if (error) {
    // access_denied is the user pressing Cancel, not a failure to report.
    if (error !== "access_denied") {
      loginFailed(params.get("error_description") || error);
    }
    return;
  }

  let nonce: unknown;
  try {
    nonce = JSON.parse(params.get("state") || "{}").nonce;
  } catch {
    // Treated as a mismatch below.
  }
  if (!expectedNonce || nonce !== expectedNonce) {
    loginFailed("the response didn't match this sign-in");
    return;
  }

  const code = params.get("code");
  if (!code) {
    loginFailed("no authorization code was returned");
    return;
  }

  const response = await requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getRedirectUri(),
    })
  );
  if (!response.ok) {
    loginFailed(`token exchange returned ${response.status}`);
    return;
  }
  const tokens: TokenResponse = await response.json();
  localStorage.setItem(USER_TOKEN_KEY, tokens.access_token);
  if (tokens.refresh_token) {
    localStorage.setItem(USER_REFRESH_KEY, tokens.refresh_token);
  }

  // With a user token and no filter, /users answers with the user.
  try {
    const me = await http
      .get<TwitchResponse<TwitchUserInformation>>(
        "https://api.twitch.tv/helix/users"
      )
      .json();
    localStorage.setItem(USER_ID_KEY, me.data[0].id);
    application.createNotification({
      message: `Signed in to Twitch as ${me.data[0].display_name}`,
    });
  } catch {
    clearUserTokens();
    loginFailed("couldn't read the signed-in account");
  }
};

const logout = async (): Promise<void> => {
  const token = localStorage.getItem(USER_TOKEN_KEY);
  clearUserTokens();
  // Best effort: the token is gone locally either way.
  if (token) {
    try {
      await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT_ID, token }).toString(),
      });
    } catch {
      // Ignore.
    }
  }
};

const searchChannels = async (
  request: SearchRequest
): Promise<SearchChannelResult> => {
  const url = "https://api.twitch.tv/helix/search/channels";
  const urlWithQuery = `${url}?query=${request.query}`;
  const response = await http.get<TwitchResponse<TwitchChannel>>(urlWithQuery).json();
  const channels: Channel[] = response.data.map(
    (d): Channel => ({
      apiId: d.broadcaster_login,
      name: d.display_name,
      images: [{ url: d.thumbnail_url }],
      isLive: d.is_live,
    })
  );
  return {
    items: channels,
  };
};

const twitchVideoToVideo = (twitchVideo: TwitchVideo): Video => {
  return {
    title: twitchVideo.title,
    apiId: twitchVideo.id,
    duration: toSeconds(parse(`PT${twitchVideo.duration.toUpperCase()}`)),
    images: [
      {
        url: twitchVideo.thumbnail_url
          .replace("%{width}", "200")
          .replace("%{height}", "200"),
        height: 250,
        width: 250,
      },
    ],
    channelApiId: twitchVideo.user_login,
    channelName: twitchVideo.user_name,
  };
};

const getChannelVideos = async (
  request: ChannelVideosRequest
): Promise<ChannelVideosResult> => {
  const url = "https://api.twitch.tv/helix/videos";
  const type = "archive";
  const userId = await getIdFromChannelName(request.apiId || "");
  const urlWithQuery = `${url}?user_id=${userId}&type=${type}`;
  const response = await http.get<TwitchResponse<TwitchVideo>>(urlWithQuery).json();
  const videos: Video[] = response.data.map(twitchVideoToVideo);

  const streamUrl = "https://api.twitch.tv/helix/streams";
  const streamUrlWithQuery = `${streamUrl}?user_id=${userId}&live=true`;
  const streamResponse = await http.get<TwitchResponse<TwitchStream>>(
    streamUrlWithQuery
  ).json();
  const isLive = streamResponse.data.length > 0;

  return {
    items: videos,
    isLive,
  };
};

const getVideo = async (request: GetVideoRequest): Promise<Video> => {
  const url = "https://api.twitch.tv/helix/videos";
  const urlWithQuery = `${url}?id=${request.apiId}`;
  const response = await http.get<TwitchResponse<TwitchVideo>>(urlWithQuery).json();
  const videos: Video[] = response.data.map(twitchVideoToVideo);

  return videos[0];
};

const getLiveVideo = async (request: GetLiveVideoRequest) => {
  const url = "https://api.twitch.tv/helix/streams";
  const userId = await getIdFromChannelName(request.channelApiId);
  const urlWithQuery = `${url}?user_id=${userId}&live=true`;
  const response = await http.get<TwitchResponse<TwitchStream>>(urlWithQuery).json();
  if (response.data.length > 0) {
    const videos = response.data.map(
      (d): Video => ({
        title: d.title,
        channelName: d.user_name,
        channelApiId: d.user_login,
      })
    );
    return videos[0];
  }
};

// Enough to fill the home grid at every column count without a second page.
const TOP_STREAM_COUNT = 24;
// Helix's page limit, and /users takes at most this many ids, so the whole
// followed list costs one request each.
const MAX_PAGE = 100;

/**
 * Cards for live streams. Avatars are one extra request for the whole page;
 * the cards fall back to the channel's initial, so the streams are still
 * worth showing without it.
 */
const streamsToVideos = async (streams: TwitchStream[]): Promise<Video[]> => {
  const avatars = new Map<string, string>();
  if (streams.length > 0) {
    try {
      const ids = streams.map((s) => `id=${s.user_id}`).join("&");
      const users = await http
        .get<TwitchResponse<TwitchUserInformation>>(
          `https://api.twitch.tv/helix/users?${ids}`
        )
        .json();
      for (const user of users.data) {
        avatars.set(user.id, user.profile_image_url);
      }
    } catch {
      // See above.
    }
  }

  return streams.map((stream): Video => {
    const avatar = avatars.get(stream.user_id);
    return {
      title: stream.title,
      apiId: stream.id,
      channelApiId: stream.user_login,
      channelName: stream.user_name,
      channelImages: avatar ? [{ url: avatar }] : undefined,
      views: stream.viewer_count,
      isLive: true,
      // Stream previews use {width}, unlike the %{width} of video thumbnails.
      images: [
        {
          url: stream.thumbnail_url
            .replace("{width}", "640")
            .replace("{height}", "360"),
          width: 640,
          height: 360,
        },
      ],
      originalUrl: `https://www.twitch.tv/${stream.user_login}`,
    };
  });
};

/**
 * Twitch has no "trending videos": what its front page leads with is the
 * streams live right now, most watched first.
 */
const getTopItems = async (): Promise<SearchAllResult> => {
  const url = "https://api.twitch.tv/helix/streams";
  const response = await http
    .get<TwitchResponse<TwitchStream>>(`${url}?first=${TOP_STREAM_COUNT}`)
    .json();
  return { videos: { items: await streamsToVideos(response.data) } };
};

/**
 * The live channels the user follows, as on twitch.tv's Following page.
 * Empty when signed out, or when none of them are live, so Home falls back
 * to the top streams.
 */
const getUserFeed = async (): Promise<SearchVideoResult> => {
  const userId = localStorage.getItem(USER_ID_KEY);
  if (!isLoggedIn() || !userId) return { items: [] };

  const url = "https://api.twitch.tv/helix/streams/followed";
  const response = await http
    .get<TwitchResponse<TwitchStream>>(
      `${url}?user_id=${userId}&first=${MAX_PAGE}`
    )
    .json();
  return { items: await streamsToVideos(response.data) };
};

const searchAll = async (request: SearchRequest): Promise<SearchAllResult> => {
  const channelsPromise = searchChannels(request);
  const [channels] = await Promise.all([channelsPromise]);
  return { channels };
};

application.onSearchAll = searchAll;
application.onGetTopItems = getTopItems;
application.onGetUserFeed = getUserFeed;
application.onLogin = login;
application.onLoginCallback = loginCallback;
application.onLogout = logout;
application.onIsLoggedIn = async () => isLoggedIn();
application.onGetChannelVideos = getChannelVideos;
application.onSearchChannels = searchChannels;
application.onGetVideo = getVideo;
application.onGetLiveVideo = getLiveVideo;

application.onUiMessage = async (message: UiMessageType) => {
  switch (message.type) {
    case "endvideo":
      application.endVideo();
      break;
  }
};

const init = () => {};

init();

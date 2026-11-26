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

export const TOKEN_SERVER =
  "https://cloudflare-worker-token-service.audio-pwa.workers.dev/token";
const CLIENT_ID = "19tpyf3jn7o7c05mk774ira19x8bbp";

export const setToken = (accessToken: string) => {
  localStorage.setItem("access_token", accessToken);
};

const http = ky.create({
  headers: {
    "Client-Id": CLIENT_ID,
  },
  hooks: {
    beforeRequest: [
      (request) => {
        const token = localStorage.getItem("access_token");
        if (token) {
          request.headers.set("Authorization", "Bearer " + token);
        }
      },
    ],
    afterResponse: [
      async (request, options, response) => {
        if (response.status === 401) {
          const accessToken = await refreshToken();
          request.headers.set("Authorization", "Bearer " + accessToken);
          return http(request);
        }
      },
    ],
  },
});

export const refreshToken = async () => {
  const params = new URLSearchParams();
  params.append("client_id", CLIENT_ID);
  params.append("grant_type", "client_credentials");

  const result = await http.post<TokenResponse>(TOKEN_SERVER, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  }).json();
  if (result.access_token) {
    return result.access_token;
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

/**
 * Twitch has no "trending videos": what its front page leads with is the
 * streams live right now, most watched first.
 */
const getTopItems = async (): Promise<SearchAllResult> => {
  const url = "https://api.twitch.tv/helix/streams";
  const response = await http
    .get<TwitchResponse<TwitchStream>>(`${url}?first=${TOP_STREAM_COUNT}`)
    .json();
  const streams = response.data;

  // Avatars are one extra request for the whole page; the cards fall back to
  // the channel's initial, so the streams are still worth showing without it.
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

  const items = streams.map((stream): Video => {
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

  return { videos: { items } };
};

const searchAll = async (request: SearchRequest): Promise<SearchAllResult> => {
  const channelsPromise = searchChannels(request);
  const [channels] = await Promise.all([channelsPromise]);
  return { channels };
};

application.onSearchAll = searchAll;
application.onGetTopItems = getTopItems;
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

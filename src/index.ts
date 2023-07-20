import axios from "axios";
import {
  MessageType,
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
  );
  return response.data.data[0].id;
};

export const TOKEN_SERVER =
  "https://cloudflare-worker-token-service.audio-pwa.workers.dev/token";
const CLIENT_ID = "19tpyf3jn7o7c05mk774ira19x8bbp";
const http = axios.create();

export const setToken = (accessToken: string) => {
  localStorage.setItem("access_token", accessToken);
};

export const refreshToken = async () => {
  const params = new URLSearchParams();
  params.append("client_id", CLIENT_ID);
  params.append("grant_type", "client_credentials");

  const result = await http.post(TOKEN_SERVER, params, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  if (result.data.access_token) {
    return result.data.access_token as string;
  }
};

http.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("access_token");
    if (token) {
      config.headers["Authorization"] = "Bearer " + token;
    }
    return config;
  },
  (error) => {
    Promise.reject(error);
  }
);

http.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error) => {
    const originalRequest = error.config;
    if (error.response.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      const accessToken = await refreshToken();
      http.defaults.headers.common["Client-Id"] = CLIENT_ID;
      http.defaults.headers.common["Authorization"] = "Bearer " + accessToken;
      return http(originalRequest);
    }
  }
);

const searchChannels = async (
  request: SearchRequest
): Promise<SearchChannelResult> => {
  const url = "https://api.twitch.tv/helix/search/channels";
  const urlWithQuery = `${url}?query=${request.query}`;
  const response = await http.get<TwitchResponse<TwitchChannel>>(urlWithQuery);
  const channels: Channel[] = response.data.data.map(
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
  const response = await http.get<TwitchResponse<TwitchVideo>>(urlWithQuery);
  const videos: Video[] = response.data.data.map(twitchVideoToVideo);

  const streamUrl = "https://api.twitch.tv/helix/streams";
  const streamUrlWithQuery = `${streamUrl}?user_id=${userId}&live=true`;
  const streamResponse = await http.get<TwitchResponse<TwitchStream>>(
    streamUrlWithQuery
  );
  const isLive = streamResponse.data.data.length > 0;

  return {
    items: videos,
    isLive,
  };
};

const getVideo = async (request: GetVideoRequest): Promise<Video> => {
  const url = "https://api.twitch.tv/helix/videos";
  const urlWithQuery = `${url}?id=${request.apiId}`;
  const response = await http.get<TwitchResponse<TwitchVideo>>(urlWithQuery);
  const videos: Video[] = response.data.data.map(twitchVideoToVideo);

  return videos[0];
};

const getLiveVideo = async (request: GetLiveVideoRequest) => {
  const url = "https://api.twitch.tv/helix/streams";
  const userId = await getIdFromChannelName(request.channelApiId);
  const urlWithQuery = `${url}?user_id=${userId}&live=true`;
  const response = await http.get<TwitchResponse<TwitchStream>>(urlWithQuery);
  if (response.data.data.length > 0) {
    const videos = response.data.data.map(
      (d): Video => ({
        title: d.title,
        channelName: d.user_name,
        channelApiId: d.user_login,
      })
    );
    return videos[0];
  }
};

const searchAll = async (request: SearchRequest): Promise<SearchAllResult> => {
  const channelsPromise = searchChannels(request);
  const [channels] = await Promise.all([channelsPromise]);
  return { channels };
};

application.onSearchAll = searchAll;
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

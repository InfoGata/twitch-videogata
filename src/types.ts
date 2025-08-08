type UiEndVideoType = {
  type: "endvideo";
};

export type TokenResponse = {
  access_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
};

export type UiMessageType = UiEndVideoType;

type ChannelNameType = {
  type: "channelName";
  channelName: string;
};

export type MessageType = ChannelNameType;

export interface TwitchVideo {
  id: string;
  user_id: string;
  user_name: string;
  user_login: string;
  title: string;
  description: string;
  view_count: number;
  duration: string;
  thumbnail_url: string;
}

export interface TwitchResponse<T> {
  data: T[];
}

export interface TwitchStream {
  id: string;
  user_id: string;
  user_name: string;
  user_login: string;
  title: string;
  thumbnail_url: string;
  started_at: string;
}

export interface TwitchChannel {
  id: string;
  broadcaster_login: string;
  thumbnail_url: string;
  is_live: boolean;
  display_name: string;
}

export interface TwitchChannelInformation {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
}

export interface TwitchUserInformation {
  id: string;
  login: string;
  display_name: string;
}

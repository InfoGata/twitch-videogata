import { MessageType, UiMessageType } from "./types";

interface TwitchPlayerOptions {
  width: string | number;
  height: string | number;
  channel?: string;
  video?: string;
  collection?: string;
  parent?: string[];
  autoplay?: boolean;
  muted?: boolean;
  time?: string;
}

interface TwitchPlayer {
  addEventListener: (event: string, callback: Function) => void;
}

declare global {
  const Twitch: {
    Player: any;
  };
}

const playerOptions: TwitchPlayerOptions = {
  height: "100%",
  width: "100%",
  parent: ["www.videogata.com", "localhost", "preview.videogata.com"],
};

const playVideo = (videoId: string) => {
  const options: TwitchPlayerOptions = { ...playerOptions, video: videoId };
  const player: TwitchPlayer = new Twitch.Player("player", options);
  player.addEventListener(Twitch.Player.ENDED, () => {
    sendMessage({ type: "endvideo" });
  });
};

const playLiveStream = (channelApiId: string) => {
  const options: TwitchPlayerOptions = {
    ...playerOptions,
    channel: channelApiId,
  };
  const player: TwitchPlayer = new Twitch.Player("player", options);
};

const sendMessage = (message: UiMessageType) => {
  parent.postMessage(message, "*");
};

const loadScript = (src: string) => {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = src;
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      reject();
    };
    document.head.appendChild(script);
  });
};

export const init = async () => {
  await loadScript("https://player.twitch.tv/js/embed/v1.js");
  const params = new URLSearchParams(window.location.search);

  // Retrieve video info
  const apiId = params.get("apiId");
  const isLive = params.get("isLive");
  const channelApiId = params.get("channelApiId");
  if (isLive === "true") {
    if (channelApiId) {
      playLiveStream(channelApiId);
    }
  } else {
    if (apiId) {
      playVideo(apiId);
    }
  }
};

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

// Twitch refuses to play unless every page the embed sits in is named in
// `parent`. This player runs in a frame on the plugin's own subdomain
// (`<plugin id>.videogata.com`, or `<plugin id>.localhost` in dev), inside the
// app, so both hostnames are needed. Neither is fixed, so they are read here
// instead of being listed by hand.
export const getParentHosts = (): string[] => {
  const hosts = new Set<string>([window.location.hostname]);
  const ancestors = window.location.ancestorOrigins;
  if (ancestors) {
    for (let i = 0; i < ancestors.length; i++) {
      hosts.add(new URL(ancestors[i]).hostname);
    }
  }
  // Firefox has no ancestorOrigins; the referrer still carries the app's origin.
  if (document.referrer) {
    hosts.add(new URL(document.referrer).hostname);
  }
  hosts.delete("");
  // In case neither of the above names the app's own page.
  hosts.add("www.videogata.com");
  return [...hosts];
};

const playerOptions = (): TwitchPlayerOptions => ({
  height: "100%",
  width: "100%",
  parent: getParentHosts(),
});

const playVideo = (videoId: string) => {
  const options: TwitchPlayerOptions = { ...playerOptions(), video: videoId };
  const player: TwitchPlayer = new Twitch.Player("player", options);
  player.addEventListener(Twitch.Player.ENDED, () => {
    sendMessage({ type: "endvideo" });
  });
};

const playLiveStream = (channelApiId: string) => {
  const options: TwitchPlayerOptions = {
    ...playerOptions(),
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

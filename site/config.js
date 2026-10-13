// BetterChat client configuration.
//
// realtimeUrl is the chat feed: the /realtime relay (betterchat/relay.py).
// Left null, the page uses this origin's own, which is what a deployment of
// this repo serves. Inside the KickPlus extension the feed comes from the
// extension and this is not used.
window.BETTERCHAT_CONFIG = {
  kickApiBase: 'https://kick.com/api/v2',
  realtimeUrl: null,
};

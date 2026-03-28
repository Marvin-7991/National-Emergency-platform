// API base URLs — proxied through Vercel to avoid CORS (HTTP requests).
// dispatchWs is a direct WSS connection (Vercel cannot proxy WebSockets).
window.ENV = {
  auth:       "/proxy/auth",
  incident:   "/proxy/incident",
  dispatch:   "/proxy/dispatch",
  analytics:  "/proxy/analytics",
  dispatchWs: "wss://national-emergency-platform-dispatch-api.onrender.com",
};

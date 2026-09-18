module.exports = {
  parse: {
    baseUrl: "https://api.parse.bot/scraper/d41feb62-afc3-401a-a12e-3bf6c0b5cf31",
    apiKey: process.env.PARSE_API_KEY,
    defaultPerPage: 20,
    maxPerPage: 50,
  },
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    env: process.env.NODE_ENV || "development",
  },
};

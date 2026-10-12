# Live mode setup (10 minutes, free)
1. cloudflare.com → sign up → Workers & Pages → Create → Worker → Edit code → paste `worker.js` → Deploy.
2. Worker → Settings → Variables and Secrets, add (type Secret):
   - SERPER_KEY = your key from serper.dev
   - ACCESS_TOKEN = any long random password you choose
   - (optional) ALLOWED_ORIGIN = https://YOURNAME.github.io
3. Copy the worker URL (https://xxxx.workers.dev).
4. Upload `leadfinder.html` to GitHub Pages (or open it locally), paste Worker URL + token, search.
Notes: For 500 results use "Up to 500"; if Google returns fewer for one area, enter several areas separated by ; (e.g. Toronto; Mississauga; Brampton). Each Maps page uses Serper credits. Free Worker plan allows ~100k requests/day. Only public business info is read; robots.txt respected.

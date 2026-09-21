# Privacy

TabJev is a load-unpacked Chrome extension. There is no backend operated by
this project — every network request goes directly from your browser to the
endpoint you configure.

## What it reads

- The URL and title of any tab that finishes loading, is not pinned, is not
  already in a group, and starts with `http` or `https`.
- The titles of your existing Chrome tab groups, and the URL and title of up
  to three tabs already in each group, used to describe that group to Jev.

## What it transmits, and to whom

Only to the base URL you configured in the options page (default
`https://api.typesafe.ai`). Nothing is sent to any other host. If you change
the base URL to a gateway (OpenRouter, Vercel AI Gateway, Cloudflare AI
Gateway), requests go there instead, and Chrome will ask you to grant
permission for that host before the extension can reach it.

By default, a tab's query string and URL hash are stripped before the URL is
sent (`stripQuery`, on by default). This matters because a query string can
carry a session token or other sensitive parameter that has no business
leaving your browser.

## What it stores, and where

Your API key, the endpoint, and all other settings are stored in
`chrome.storage.local`. They are never written to `chrome.storage.sync`, so
your key never syncs to your Google account or to any other machine signed
into it. A local decision log (host, matched group, confidence, latency) is
also kept in `chrome.storage.local`, capped at the 200 most recent entries.

## What it never does

- No telemetry.
- No analytics.
- No third-party server operated by the author of this extension.
- No sale or sharing of your data with anyone.

## How to delete everything

- Remove the extension from `chrome://extensions` — this deletes everything
  `chrome.storage.local` was holding, including your key and the log.
- Or, without uninstalling: clear the decision log from the options page
  ("Clear log"), and clear the API key field to remove the stored key.

## Contact

Open an issue on the repository:
https://github.com/rishhavv/tabjev/issues

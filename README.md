# evcc minimalistic charger GUI

A compact, responsive web display for evcc. A single Go process serves the UI and proxies its small set of required API calls to evcc; no separate web server or JavaScript dependencies are needed.

The display follows the visual language and data presentation of [evcc-garage-display](https://github.com/tobymarks/evcc-garage-display), adapted from a fixed square screen to responsive browser layouts. Its API fields and charging-mode mappings are derived from that project. This project was created with GitHub Copilot.

## Run

Requires Go 1.22 or newer:

```sh
go run . --port 8080 --evcc http://192.168.1.20:7070
```

Then open `http://<server>:8080/`. The `--evcc` option can also be set with `EVCC_URL`; its default is `http://127.0.0.1:7070`. The server binds to all interfaces. Build a self-contained executable with:

```sh
go build -o evcc-display .
./evcc-display --port 8080 --evcc http://192.168.1.20:7070
```

The Go process serves the embedded HTML, CSS, JavaScript, and translations and makes same-origin requests to evcc. This avoids browser CORS requirements. The browser should be able to reach this app; only the app process needs to reach evcc.

## URL options

Pass options as query parameters on the display URL, for example:

```text
http://display-host:8080/?control=1&preselect=2&preselectTimeout=60&screenTimeout=120&theme=dark&lang=de
```

| Parameter | Default | Description |
| --- | --- | --- |
| `control` | `0` | Set to `1` to show the **Smart**, **Slow**, and **Fast** charging-mode buttons. |
| `autoSwitch` | `1` | Automatically switch to a newly connected vehicle or a loadpoint whose charging state changed. Set to `0` to disable. As in the source display, automatic switching is suppressed for 60 seconds after user interaction. |
| `preselect` | none | evcc loadpoint number to return to after manual browsing, **1-based** as in evcc (for example `2`). It must be included by the allow/block list. |
| `preselectTimeout` | `60` | Seconds without user interaction before returning to `preselect`. `0` disables the return. |
| `screenTimeout` | `120` | Seconds without charging or interaction before the display goes completely black. `0` keeps it on. With `preselect`, only that loadpoint counts, and the timer runs only while it is displayed. Tap anywhere to wake it. |
| `theme` | `dark` | `dark` or `light`. |
| `lang` | browser language | Translation language (`de` or `en`). A regional tag such as `de-CH` uses its base language; unsupported languages fall back to English. |
| `allowlist` | all loadpoints | Comma-separated evcc loadpoint numbers to show, e.g. `allowlist=1,3`. |
| `blocklist` | none | Comma-separated evcc loadpoint numbers to hide, e.g. `blocklist=2`. Cannot be used with `allowlist`. |

Loadpoints can always be switched manually by swiping left/right or tapping the left/right edge of the display. The tap zones are the outer 14% on each side; they stay clear of the centered controls, including when mode control is enabled. Switching stops at the first and last displayed loadpoint.

## Display and controls

The responsive layout scales its spacing and typography with the available viewport and adapts to portrait and landscape aspect ratios. It shows the loadpoint name and time, vehicle and state of charge, charging power, evcc status, solar/grid share, session data, and—when no vehicle is connected and PV data is available—house, solar, and battery flow.

By default, the only interaction is switching loadpoints. When `control=1`, the mode buttons map to evcc as follows:

| Button | evcc API behavior |
| --- | --- |
| Smart | `alwayscharge/off`, then `mode/smart` (older evcc: `mode/pv`) |
| Slow | `alwayscharge/on`, then `mode/smart` (older evcc: `mode/minpv`) |
| Fast | `mode/now` |

## evcc API

The page polls `GET /api/state?jq=…` every three seconds. The jq projection follows `src/evcc_client.cpp` in the source project and requests the loadpoint mode, vehicle, power, charging/session state, plus PV, home, battery, and grid data. Mode buttons proxy `POST /api/loadpoints/{number}/…`.

The server forwards only `GET /api/state` and the supported loadpoint mode/always-charge `POST` routes. It is not a general-purpose proxy. The browser talks to this app on the same origin, so evcc does not need to enable cross-origin access.

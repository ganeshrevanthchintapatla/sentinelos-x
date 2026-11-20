# SentinelOS X

SentinelOS X is a real-time cyber incident command center for HackUTD 2026. It models an organization's infrastructure as a live digital twin so responders can see what broke, understand the blast radius, and compare safe recovery options before taking action.

The system combines:

- A SpacetimeDB-backed digital twin with role-checked reducers, audit history, incident evidence, containment, and two-person recovery.
- A React/Vite command-center UI with service health, incident search, blast-radius visualization, telemetry, and the Response Decision Lab.
- An NVIDIA Nemotron investigation agent that uses read-only tools, cites retrieved evidence, and requires human approval for operational changes.
- An optional Arduino UNO R4 WiFi + DHT11 sensor bridge for real temperature and humidity incidents.

All infrastructure, incidents, and telemetry are synthetic unless explicitly marked as readings from the optional physical sensor.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`SentinelOS-X/`](SentinelOS-X/) | Main SpacetimeDB module, frontend, services, and local development commands |
| [`agent/`](agent/) | Standalone Python/FastAPI Nemotron investigation agent |
| [`hardware/`](hardware/) | Sensor bridge and Arduino firmware |
| [`arduino/`](arduino/) | Arduino sketches and supporting hardware files |
| [`PROJECT_STORY.md`](PROJECT_STORY.md) | Project motivation, architecture, and lessons learned |

## Run the command center locally

Prerequisites: Node.js 22+, npm, and the SpacetimeDB CLI 2.14.x.

```bash
cd SentinelOS-X
npm run install:all
spacetime start
npm run publish:local
npm run dev
```

The frontend opens at `http://localhost:5173`. For the optional Nemotron agent, configure `NVIDIA_API_KEY` in `SentinelOS-X/services/.env`, then run:

```bash
npm --prefix services run agent
```

See [`SentinelOS-X/README.md`](SentinelOS-X/README.md) for the complete architecture, configuration, demo, migration, and validation notes.

## Safety and data

This repository is a demo and research project. It does not connect to real production infrastructure. Never commit API keys, Wi-Fi credentials, device tokens, or local `.env` files. Copy the provided `.env.example` and Arduino template files when configuring a local demo.

## HackUTD 2026

Built for the NVIDIA *Nemotron Beyond a Chatbot*, Winstead PC *Cyber Incident Response Dashboard*, and SpacetimeDB *Real-Time Application* tracks.

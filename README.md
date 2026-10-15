# Tire curing press TCP-01 on Siemens Industrial Edge

A simulated tire curing press with its PLC program, built to run on an Industrial Edge device:

- **Flow Creator** runs the simulation (plant model, PLC sequence, random anomalies) and publishes it to the
  **IE Databus** in the SIMATIC v1 format, as if an S7 connector named `tirepress1` were reading a real press.
- The **HMI app** (this repository's Docker image) reads those topics, draws the press live and writes
  operator commands back to the Databus.
- Any other IE app (Data Service, Performance Insight, AI Inference Server, your own) can read the same
  tags, and the injected anomalies have ground-truth tags to score detectors against.

```
Flow Creator: flow/tire-press-flow.json                IE Databus (MQTT, ie-databus:1883)                HMI app: Docker image
press model + PLC + anomalies ──publishes──▶  ie/m/j/simatic/v1/tirepress1/dp             ──▶  server/server.mjs ──SSE──▶ browser
                               ──publishes──▶  ie/d/j/simatic/v1/tirepress1/dp/r/factory/* ──▶        │
                             ◀──subscribes──   ie/d/j/simatic/v1/tirepress1/dp/w/factory/* ◀── POST api/write ◀── buttons
```

## Topics and payloads

Connector `tirepress1`, connection `factory`, the same layout as the Pulse Carton example flow:

| Topic | Direction | Content |
|---|---|---|
| `ie/m/j/simatic/v1/tirepress1/dp` | flow → bus, retained, every 60 s | metadata: data points, tag IDs, names, data types, `accessMode` |
| `ie/d/j/simatic/v1/tirepress1/dp/r/factory/Press_0` | flow → bus, every 500 ms | I/O image, PLC status, active recipe, positions |
| `…/dp/r/factory/Cycle_0` | flow → bus, every 500 ms | last finished tire, counters, alarms |
| `…/dp/r/factory/Anomaly_0` | flow → bus, every 500 ms | ground truth of the injected anomaly |
| `…/dp/r/factory/Command_0` | flow → bus, every 500 ms | current command and recipe settings (read-back) |
| `…/dp/w/factory/Command_0` | any app → flow | operator commands |
| `…/dp/w/factory/AI_0` → `…/dp/r/factory/AI_0` | AI Inference Server → flow → bus | AI outputs, echoed like an S7 connector would |

Data payloads are SIMATIC v1 bulk messages, `{"seq":42,"vals":[{"id":"1007","qc":3,"ts":"2026-10-15T08:39:05.352Z","val":true}]}`.
Writes use `{"seq":1,"vals":[{"id":"1131","val":true}]}`; look up the IDs in the metadata. Tag names are
`TCP01.<path>`, for example `TCP01.IO.AI.PT_BLAD` or `TCP01.Cmd.Start`.

### Tags

| Chunk | Tags |
|---|---|
| `Press_0` (95) | `Info.*`; `IO.DI.*` (22 inputs), `IO.DO.*` (23 outputs), `IO.AI.*` (TT_TOP, TT_BOT, PT_BLAD, TT_BLAD, PT_HYD, ZT_PRESS, IT_LDR, IT_UNL), `IO.AO.*`; `PLC.State/Step/StepName/Phase/StepTimeS/Faulted/FaultText/…`; `Recipe.Active.*`; `Process.CureIndexPct`; `Motion.*` (positions for the drawing) |
| `Cycle_0` (32) | `Cycle.Total/Good/Rejected`; `Cycle.Last.*` (serial, cycle time, peak pressure, platen mean, minimum squeeze, cure index, OK, reason, alarms, setpoints); `Alarm.*` incl. one `Alarm.Active.<code>` per alarm |
| `Anomaly_0` (11) | `Anomaly.Active/TypeCode/Type/Severity/EventId/StartUtc/EndUtc/SecondsRemaining/Count/IntegratedSeconds/LastCycleTypes` |
| `Command_0` (19, rw) | `Cmd.Start/Stop/Reset` (pulses), `Cmd.EStop`, `Cmd.Mode` (0 auto, 1 single), `Cmd.CureWarp`, `Cmd.Recipe.*`, `Cmd.Fault.Leak/Sag/Grip/Guard`, `Cmd.Anomaly.RandomEnabled/MeanIntervalMin/Inject/Clear` |
| `AI_0` (3, rw) | `AI.AnomalyScore` (0..1000 ‰), `AI.Status` (0 normal, 1 warning, 2 alarm), `AI.PredictedType` (anomaly code) |

`TCP01.Info.DataOrigin` is always `ENGINEERING_SIMULATION`. The cure steps run `Cmd.CureWarp` times faster
than wall time (30× by default), so one tire takes about 70 s; `Info.ProcessSeconds` keeps process time.

## Anomalies

One anomaly at a time, started at random: the mean gap is `Cmd.Anomaly.MeanIntervalMin` (10 min by default,
exponentially distributed, at least 1 min), each lasts 2 to 7 minutes, and severity is random between 0.35 and 1.
The first comes 2 to 5 minutes after the flow starts. Each one acts on the plant or a sensor inside the model,
never on a published value, so its signature travels through the PLC like a real fault would.

| Code | `Anomaly.Type` | What happens | Where it shows |
|---|---|---|---|
| 1 | `bladder_leak` | slow leak in the bladder | `PT_BLAD` below `Recipe.Active.N2P` in CURE_N2; under-cured tires at high severity |
| 2 | `steam_supply_sag` | steam header pressure drops | `PT_BLAD` low in CURE_STEAM, `TCV_PLATEN` higher, alarm A101, rejected tires |
| 3 | `platen_steam_trap` | bottom platen floods with condensate | `TT_BOT` falls, `TT_TOP` rises, `TCV_PLATEN` opens wider |
| 4 | `hydraulic_leak` | clamp force bleeds off between pump cycles | `PT_HYD` low and sawtoothing in the cure, slower SQUEEZE step |
| 5 | `platen_sensor_drift` | `TT_TOP` transmitter drifts high | `TT_TOP − TT_BOT` grows while the real platens cool; cure index drops |
| 6 | `pressure_sensor_noise` | `PT_BLAD` transmitter noisy with spikes | high variance on `PT_BLAD`; spikes can fake A101 |
| 7 | `loader_drive_friction` | loader carriage drags | `IT_LDR` up, LOAD_IN and LOADER_OUT take longer, longer cycle time |
| 8 | `nitrogen_supply_low` | nitrogen header below recipe | `PT_BLAD` low in CURE_N2, alarm A102, rejected tires |

None of them stops the press. Use the `Anomaly_0` tags as labels only: keep them out of detector inputs.
`Anomaly.LastCycleTypes` and `Cycle.Last.*` label every finished tire. To trigger one by hand, write its code
to `TCP01.Cmd.Anomaly.Inject`, from the HMI's Anomalies card or from the inject node in the flow.
The four manual faults on the HMI (`Cmd.Fault.*`) are separate and can stop the press.

## Deploy on Industrial Edge

1. **Databus**: in the IE Databus configuration, create a user (for example `edge`) with publish and subscribe
   rights on `ie/#`, and deploy the configuration.
2. **Flow Creator**: import `flow/tire-press-flow.json` (menu → Import). Open the broker node
   *Industrial Edge Databus*, enter the Databus user on the Security tab, and deploy. The function node's
   status shows the cycle, the step and any active anomaly. Give the flow persistent context if counters
   should survive a restart.
3. **HMI app**: build an amd64 image and push it to a registry your App Publisher can reach:
   ```sh
   docker buildx build --platform linux/amd64 -t <registry>/tire-curing-press-hmi:2.0.0 --push .
   ```
   In the Industrial Edge App Publisher, create the app from `edge/docker-compose.yml` (set the image name and
   the Databus credentials), and add a reverse-proxy entry for service `tire-press-hmi`, port `8080`,
   path `tire-press/`. Install it on the device and open it from the IED's app list.
4. Other apps: point Data Service or Performance Insight at connector `tirepress1`, or map the `TCP01.*` tags
   as AI Inference Server inputs and its outputs to `TCP01.AI.*`.

The HMI's environment variables: `DATABUS_URL` (default `mqtt://ie-databus:1883`), `DATABUS_USER`,
`DATABUS_PASSWORD`, `CONNECTOR` (`tirepress1`), `CONNECTION` (`factory`), `PORT` (`8080`) and
`WRITES_ENABLED` (`false` makes the HMI read-only). The server has no login of its own: it relies on the
IED's reverse proxy for access control.

## Run everything on one machine

```sh
docker compose --profile local up -d --build
```

This starts the HMI at <http://localhost:8080>, Mosquitto as a stand-in Databus under the same host name
(`ie-databus`, also on `localhost:1883` for MQTT Explorer), and Node-RED as a stand-in Flow Creator with the
generated flow on <http://localhost:1880>. `docker compose up -d --build` without the profile starts only
the HMI, for a broker you name in `DATABUS_URL`.

`tire-curing-press.html` is a standalone copy that runs the same model inside the page, for demos without any
broker.

## Develop

| File | Role |
|---|---|
| `sim/press-model.js` | the model, the PLC program, the anomalies and the tag interface. The flow and the page both embed it. |
| `flow/build-flow.mjs` | writes `flow/tire-press-flow.json` from the model; `--connector`, `--connection` and `--publish-ms` change the topics and rate |
| `server/server.mjs` | the HMI backend: Databus ↔ browser |
| `live.js`, `app.html`, `app.css`, `build.mjs` | the HMI page; `build.mjs` writes `public/index.html` (databus) and `tire-curing-press.html` (standalone) |
| `test/` | model tests: `npm test` |

After changing the model, rebuild both outputs and re-import the flow:

```sh
npm run build        # page and flow; build.mjs needs the anatomy kit (ANATOMY_KIT, default ~/.claude/skills/anatomy)
npm run build:flow   # flow only
npm test
```

Tag IDs are positions in the registry, so add new tags at the end of their group to keep existing IDs stable.
A new `VERSION` in the model resets the flow's stored state on the next tick.

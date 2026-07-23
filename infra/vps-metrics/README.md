# VPS metrics support

This directory is the versioned source for the collector integration consumed
by `infra/hermes-ha`. Production copies are deployment artifacts, not source
trees. Keep host-specific configuration outside Git; start from
`config.hermes-ha.example.json` and install only from the same reviewed release
artifact as Hermes HA.

## Related: on-host load sampler

`collector.py` remains the off-host DMIT account / reachability collector.
Continuous lightweight CPU/memory/swap/load + Docker/Hermes/top samples for
ongoing optimization live in Hermes HA (deployed to the VPS itself):

- `infra/hermes-ha/scripts/sample-host-load.py`
- `infra/hermes-ha/systemd/hermes-ha-host-load.{service,timer}` (every 2 min)
- state: `~/.local/state/hermes-ha/host-load/` (`latest.json` + rolling `samples/`)
- one-shot / local wrapper: `scripts/perf/sample-host-load.sh`

Run the compatibility test from the repository root:

```bash
python3 infra/vps-metrics/test_collector_stale_refresh.py
```

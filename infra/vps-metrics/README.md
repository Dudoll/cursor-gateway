# VPS metrics support

This directory is the versioned source for the collector integration consumed
by `infra/hermes-ha`. Production copies are deployment artifacts, not source
trees. Keep host-specific configuration outside Git; start from
`config.hermes-ha.example.json` and install only from the same reviewed release
artifact as Hermes HA.

Run the compatibility test from the repository root:

```bash
python3 infra/vps-metrics/test_collector_stale_refresh.py
```

# Fixture: compliant TestNet compatibility writer

Rust neo-os-relayer is the production writer. Start the Node oneshot only after
creating ENABLE_NODE_FEED_PUSHER_COMPAT and stopping both Rust relayers.

```bash
systemctl start morpheus-feed-pusher-testnet.service
```

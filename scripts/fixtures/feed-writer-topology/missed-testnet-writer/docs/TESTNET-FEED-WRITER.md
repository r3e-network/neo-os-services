# Fixture: boot-enabled TestNet writer

Operators were incorrectly told to enable the Node writer:

```bash
systemctl enable --now morpheus-feed-pusher-testnet.timer
```

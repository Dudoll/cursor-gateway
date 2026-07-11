# Existing Reverse Proxy Integration

The default Compose deployment does not bind public ports 80 or 443. It exposes the app only on:

```text
127.0.0.1:18080
```

Point your public reverse proxy for `gateway.example.com` to that local address.

## Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name gateway.example.com;

    # Keep your existing ssl_certificate settings here.

    location / {
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Caddy

```caddyfile
gateway.example.com {
  reverse_proxy 127.0.0.1:18080
}
```

## Cloudflare Access

Keep Cloudflare Access in front of `https://gateway.example.com`. The app still validates `CF-Access-Authenticated-User-Email` against `ALLOWED_EMAILS`.

## Optional Project-Owned Caddy

Only use this if ports 80 and 443 are free:

```bash
docker compose --profile edge up -d --build
```

#!/bin/bash
# Adds HTTP basic auth to phpMyAdmin, listens on Railway's $PORT, then starts the
# image's own entrypoint. Refuses to start without a strong basic-auth password.
set -euo pipefail

if [ -z "${PMA_BASIC_AUTH_USER:-}" ] || [ -z "${PMA_BASIC_AUTH_PASSWORD:-}" ]; then
  echo "Refusing to start: set PMA_BASIC_AUTH_USER and PMA_BASIC_AUTH_PASSWORD." >&2
  exit 1
fi
if [ "${#PMA_BASIC_AUTH_PASSWORD}" -lt 20 ]; then
  echo "Refusing to start: PMA_BASIC_AUTH_PASSWORD must be at least 20 characters." >&2
  exit 1
fi
if [ -n "${PMA_USER:-}" ] || [ -n "${PMA_PASSWORD:-}" ]; then
  echo "Refusing to start: don't set PMA_USER/PMA_PASSWORD; sign in with the database account instead." >&2
  exit 1
fi

# Railway routes traffic to $PORT.
if [ -n "${PORT:-}" ] && [ -z "${APACHE_PORT:-}" ]; then export APACHE_PORT="$PORT"; fi

mkdir -p /etc/phpmyadmin-auth
htpasswd -bBc -C 12 /etc/phpmyadmin-auth/.htpasswd "$PMA_BASIC_AUTH_USER" "$PMA_BASIC_AUTH_PASSWORD" >/dev/null
chown root:www-data /etc/phpmyadmin-auth/.htpasswd
chmod 0640 /etc/phpmyadmin-auth/.htpasswd

# "zz-" so it loads after the image's security.conf and its ServerTokens wins.
# "zz-" so it loads after the image's security.conf and its ServerTokens setting wins.
# (phpMyAdmin sends its own X-Frame-Options and X-Robots-Tag headers.)
cat > /etc/apache2/conf-enabled/zz-dcp-basic-auth.conf <<'EOF'
<Location />
  AuthType Basic
  AuthName "DCP UK database admin"
  AuthUserFile /etc/phpmyadmin-auth/.htpasswd
  Require valid-user
</Location>
Header always set Referrer-Policy "same-origin"
ServerTokens Prod
ServerSignature Off
EOF
a2enmod headers >/dev/null

# The password only lives in the hash file from here on.
unset PMA_BASIC_AUTH_PASSWORD

exec /docker-entrypoint.sh "$@"

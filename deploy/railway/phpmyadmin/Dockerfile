# phpMyAdmin for the DCP UK database on Railway (see DEPLOY.md, "phpMyAdmin").
# The official image plus a second lock: HTTP basic auth in front of phpMyAdmin's
# own database login. Keep the service stopped when nobody is using it.
FROM phpmyadmin:5.2-apache

COPY start.sh /usr/local/bin/dcp-start.sh
RUN chmod 0755 /usr/local/bin/dcp-start.sh

# Don't advertise versions; no search engine indexing.
ENV HIDE_PHP_VERSION=true

ENTRYPOINT ["/usr/local/bin/dcp-start.sh"]
CMD ["apache2-foreground"]

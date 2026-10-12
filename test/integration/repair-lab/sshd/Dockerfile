# Isolierter OpenSSH/SFTP-Testserver für das Repair Integration Lab (TF-044). NUR für Tests – nie Teil des Produktions-Images.
# Keine Schlüssel/Passwörter im Image: Host-Keys entstehen beim Containerstart, das Testpasswort setzt der Test per stdin.
FROM alpine:3.22
RUN apk add --no-cache openssh php83 \
 && ln -sf /usr/bin/php83 /usr/bin/php \
 && adduser -D -h /home/labuser -s /bin/sh labuser \
 && mkdir -p /home/labuser/public_html /home/labuser/.ssh \
 && chown -R labuser:labuser /home/labuser \
 && chmod 755 /home/labuser && chmod 700 /home/labuser/.ssh
COPY entrypoint.sh /lab/entrypoint.sh
# Windows-Checkout (autocrlf) → LF erzwingen.
RUN sed -i 's/\r$//' /lab/entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/bin/sh", "/lab/entrypoint.sh"]

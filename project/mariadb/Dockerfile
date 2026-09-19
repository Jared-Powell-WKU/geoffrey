FROM mariadb:12.1-rc

ADD defaults/ /docker-entrypoint-initdb.d

# The root password is never set here. Production reads it from mariadb.env
# and development from the root .env file (see docker-compose-dev.yaml).
ENV MARIADB_DATABASE=tncord

EXPOSE 3306

CMD ["mariadbd"]
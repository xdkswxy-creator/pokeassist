FROM python:3.12-slim

WORKDIR /app
COPY . /app

ENV PYTHONUNBUFFERED=1
ENV PYTHONIOENCODING=utf-8
ENV POKEASSIST_DATA=/var/data

# 云平台会注入 PORT；没注入时 server.py 自己会用 8765
CMD ["sh", "-c", "python3 server.py ${PORT:-8765}"]

# 開発用Dockerfile（アプリケーション層 / Rails）。
# 本番デプロイはRailwayのビルドパイプラインに委譲し、ここではdocker compose開発環境専用とする。
FROM ruby:3.3-slim

WORKDIR /app

RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    build-essential \
    libsqlite3-dev \
    libyaml-dev \
    pkg-config \
    git \
    curl

COPY Gemfile Gemfile.lock ./
RUN bundle install

COPY . .

EXPOSE 3001

CMD ["bin/rails", "server", "-b", "0.0.0.0", "-p", "3001"]

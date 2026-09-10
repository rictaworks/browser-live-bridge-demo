# アプリケーション層（Rails）のDockerfile。docker compose開発環境と
# Railway本番デプロイの両方でこのDockerfileがそのまま使われる。
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

CMD ["sh", "-c", "bin/rails db:prepare && bin/rails server -b 0.0.0.0 -p 3001"]

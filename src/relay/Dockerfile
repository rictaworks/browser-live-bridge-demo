# 開発用Dockerfile（中継層 / Gin）。
# 本番デプロイはRailwayのビルドパイプラインに委譲し、ここではdocker compose開発環境専用とする。
FROM golang:1.25-bookworm

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

EXPOSE 3002

CMD ["go", "run", "."]

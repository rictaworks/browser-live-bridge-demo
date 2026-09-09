# 開発用Dockerfile（フロントエンド / Next.js）。
# 本番デプロイはVercelのビルドパイプラインに委譲し、ここではdocker compose開発環境専用とする。
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]

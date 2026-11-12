# syntax=docker/dockerfile:1
# bafang-core 生产镜像。依赖在构建阶段装好，运行时不访问 npm、GitHub 或任何境外仓库。
# 构建：docker build -t bafang-core:<标签> .
# 国内构建机可用 --build-arg NPM_REGISTRY=https://registry.npmmirror.com 切换镜像源。

ARG NODE_IMAGE=node:20-alpine

FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    npm_config_registry=${NPM_REGISTRY} \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# 只装生产依赖（含运行 TypeScript 源码的 tsx）；锁文件不一致则构建失败。
RUN corepack enable \
 && pnpm install --frozen-lockfile --prod \
 && rm -rf /root/.cache /root/.local/share/pnpm

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY data ./data
COPY docker/core/entrypoint.sh /usr/local/bin/bafang-core
RUN chmod 0755 /usr/local/bin/bafang-core
USER node
EXPOSE 3000
# 健康检查：数据库不可达时 /v1/health 返回 503，wget 以非零退出，容器标为 unhealthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/v1/health" || exit 1
ENTRYPOINT ["/usr/local/bin/bafang-core"]
CMD ["serve"]

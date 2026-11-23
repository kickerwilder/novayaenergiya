# Образ бота. Контекст сборки: КОРЕНЬ репозитория (см. bot/docker-compose.yml), потому что боту нужен assets/calc.js.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/bot
COPY bot/package.json bot/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bot/*.js bot/prompt.md ./
COPY assets/calc.js /app/assets/calc.js
# База знаний data/kb.json монтируется томом (/app/data), см. docker-compose.yml
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const config_1 = require("prisma/config");
exports.default = (0, config_1.defineConfig)({
    schema: "prisma/schema.prisma",
    migrations: {
        path: "prisma/migrations",
    },
    datasource: {
        url: process.env["DATABASE_URL"] || "postgresql://neondb_owner:npg_jIoJHU8u7mOp@ep-cold-fire-ayzu0w7y.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require",
    },
});

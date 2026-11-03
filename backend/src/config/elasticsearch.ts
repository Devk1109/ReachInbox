import { Client } from "@elastic/elasticsearch";
import { env } from "./env";

export const elasticsearchClient = new Client({
  node: env.ELASTICSEARCH_URL,
  ...(env.ELASTICSEARCH_API_KEY ? { auth: { apiKey: env.ELASTICSEARCH_API_KEY } } : {}),
});

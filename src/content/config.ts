import { defineCollection, z } from 'astro:content';

const cvCollection = defineCollection({
  type: 'content', // v2.5+ or 'data' if JSON/YAML only, but user asked for MD
  // schema: z.object({...}) // Optional: Define schema for validation
});

const generalCollection = defineCollection({
  type: 'content',
});

export const collections = {
  'cv': cvCollection,
  'general': generalCollection,
};

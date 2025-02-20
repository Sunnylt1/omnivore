import { redisDataSource } from '../redis_data_source'
import { SpeechFile } from '@omnivore/text-to-speech-handler'
import { logger } from '../utils/logger'
import { TaskState } from '../generated/graphql'

interface Chapter {
  title: string
  id: string
  url: string
  wordCount: number
  thumbnail?: string
}

export interface Digest {
  id: string
  jobState: TaskState

  createdAt?: Date
  description?: string
  byline?: string
  url?: string
  title?: string
  content?: string
  chapters?: Chapter[]

  urlsToAudio?: string[]
  speechFiles?: SpeechFile[]
}

const digestKey = (userId: string) => `digest:${userId}`

export const getDigest = async (userId: string): Promise<Digest | null> => {
  const digest = await redisDataSource.redisClient?.get(digestKey(userId))
  return digest ? (JSON.parse(digest) as Digest) : null
}

export const writeDigest = async (userId: string, digest: Digest) => {
  // write to redis
  const result = await redisDataSource.redisClient?.set(
    digestKey(userId),
    JSON.stringify(digest),
    'EX',
    60 * 60 * 24 * 7 // 1 week
  )

  if (!result) {
    const msg = `Error while writing digest to redis: ${userId}`
    logger.error(msg)
    throw new Error(msg)
  }
}

/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/require-await */
import { makeExecutableSchema } from '@graphql-tools/schema'
import * as Sentry from '@sentry/node'
import { ContextFunction, PluginDefinition } from 'apollo-server-core'
import { Express } from 'express'
import { ApolloServer } from 'apollo-server-express'
import { ExpressContext } from 'apollo-server-express/dist/ApolloServer'
import * as httpContext from 'express-http-context2'
import * as jwt from 'jsonwebtoken'
import { EntityManager } from 'typeorm'
import { promisify } from 'util'
import { appDataSource } from './data_source'
import { sanitizeDirectiveTransformer } from './directives'
import { env } from './env'
import { createPubSubClient } from './pubsub'
import { functionResolvers } from './resolvers/function_resolvers'
import { ClaimsToSet, RequestContext, ResolverContext } from './resolvers/types'
import ScalarResolvers from './scalars'
import typeDefs from './schema'
import { tracer } from './tracing'
import { getClaimsByToken, setAuthInCookie } from './utils/auth'
import { SetClaimsRole } from './utils/dictionary'
import { logger } from './utils/logger'
import { ReadingProgressDataSource } from './datasources/reading_progress_data_source'
import { createPrometheusExporterPlugin } from '@bmatei/apollo-prometheus-exporter'
import { ApolloServerPlugin } from 'apollo-server-plugin-base'
import {
  countDailyServiceUsage,
  createServiceUsage,
} from './services/service_usage'

const signToken = promisify(jwt.sign)
const pubsub = createPubSubClient()

const resolvers = {
  ...functionResolvers,
  ...ScalarResolvers,
}

const contextFunc: ContextFunction<ExpressContext, ResolverContext> = async ({
  req,
  res,
}) => {
  logger.info(`handling gql request`, {
    query: req.body.query,
    variables: req.body.variables,
  })

  const token = req?.cookies?.auth || req?.headers?.authorization
  const claims = await getClaimsByToken(token)

  httpContext.set('claims', claims)

  async function setClaims(
    em: EntityManager,
    uuid?: string,
    userRole?: string
  ): Promise<void> {
    const uid =
      (claims && claims.uid) || uuid || '00000000-0000-0000-0000-000000000000'
    const dbRole =
      userRole === SetClaimsRole.ADMIN ? 'omnivore_admin' : 'omnivore_user'
    return em.query('SELECT * from omnivore.set_claims($1, $2)', [uid, dbRole])
  }

  const ctx = {
    log: logger,
    claims,
    pubsub,
    // no caching for subscriptions
    clearAuth: () => {
      res.clearCookie('auth')
      res.clearCookie('pendingUserAuth')
    },
    signToken,
    setAuth: async (
      claims: ClaimsToSet,
      secret: string = env.server.jwtSecret
    ) => await setAuthInCookie(claims, res, secret),
    setClaims,
    authTrx: <TResult>(
      cb: (em: EntityManager) => TResult,
      userRole?: string
    ): Promise<TResult> =>
      appDataSource.transaction(async (tx) => {
        await setClaims(tx, undefined, userRole)
        return cb(tx)
      }),
    tracingSpan: tracer.startSpan('apollo.request'),
    dataSources: {
      readingProgress: new ReadingProgressDataSource(),
    },
  }

  return ctx
}

export function makeApolloServer(app: Express): ApolloServer {
  let schema = makeExecutableSchema({
    resolvers,
    typeDefs,
  })

  schema = sanitizeDirectiveTransformer(schema)

  const promExporter: PluginDefinition = createPrometheusExporterPlugin({
    app,
    hostnameLabel: false,
    defaultMetrics: false,
    defaultLabels: {
      service: 'api',
    },
  })

  // enforce usage limits for the API
  const usageLimitPlugin = (): ApolloServerPlugin<RequestContext> => {
    // TODO: load the limit from the DB into memory when the server starts
    // hardcode the limit for now
    const MAX_SENT_EMAIL_PER_DAY = 3

    return {
      async requestDidStart(contextValue) {
        // get graphql query from the request
        const query = contextValue.request.query
        // get the user id from the claims
        const userId = contextValue.context.claims?.uid
        const action = 'replyToEmail'
        if (userId && query?.includes(action)) {
          logger.info('checking usage limit for user', { userId, action })
          // get the user's email sent count from the DB
          const emailSentCount = await countDailyServiceUsage(userId, action)
          if (emailSentCount >= MAX_SENT_EMAIL_PER_DAY) {
            logger.info('user has reached the daily email limit', {
              userId,
              action,
            })
            // if the user has reached the limit, throw an error
            throw new Error('You have reached the daily email limit')
          }
        }

        return {
          // track usage of the API
          async willSendResponse(requestContext) {
            // if the request was successful, increment the user's email sent count
            if (
              userId &&
              query?.includes(action) &&
              !requestContext.response.errors &&
              !requestContext.response.data?.replyToEmail?.errorCodes
            ) {
              logger.info('incrementing usage count for user', {
                userId,
                action,
              })
              await createServiceUsage(userId, action)
            }
          },
        }
      },
    }
  }

  const apollo = new ApolloServer({
    schema: schema,
    context: contextFunc,
    plugins: [promExporter, usageLimitPlugin],
    formatError: (err) => {
      logger.info('server error', err)
      Sentry.captureException(err)
      // hide error messages from frontend on prod
      return new Error('Unexpected server error')
    },
    introspection: env.dev.isLocal,
    persistedQueries: false,
    stopOnTerminationSignals: false, // we handle this ourselves
  })

  return apollo
}

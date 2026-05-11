import { Redis } from '@upstash/redis'

const redis = new Redis({
  url: 'https://sb-fe45e94d029a4cfe-3000.sandbox.aerol.cloud', // your upstashRestUrl
  token: 'slkvwieg423rn23r23n32unu23ngu23ng3u2ng',       // your upstashToken
})

await redis.set('foo', 'bar')
const dataResp = await redis.get('foo')

console.log('SET response:', 'foo', '=>', 'bar')
console.log('GET response:', 'foo', '=>', dataResp)
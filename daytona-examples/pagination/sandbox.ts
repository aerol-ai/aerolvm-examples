import { Daytona } from '@daytona/sdk'

async function main() {
  const daytona = new Daytona({
    apiKey: 'slkvwieg423rn23r23n32unu23ngu23ng3u2ng',
    apiUrl: 'https://sandbox.aerol.cloud/daytona',
    target: 'us',
  })

  const result = await daytona.list({ 'my-label': 'my-value' }, 2, 10)
  for (const sandbox of result.items) {
    console.log(`${sandbox.id}: ${sandbox.state}`)
  }
}

main().catch(console.error)

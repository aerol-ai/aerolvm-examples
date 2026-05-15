import { Daytona } from '@daytona/sdk'

async function main() {
  const daytona = new Daytona({
    apiKey: 'slkvwieg423rn23r23n32unu23ngu23ng3u2ng',
    apiUrl: 'https://sandbox.aerol.cloud/daytona',
    target: 'us',
  })

  const result = await daytona.snapshot.list(2, 10)
  console.log(`Found ${result.total} snapshots`)
  result.items.forEach((snapshot) => console.log(`${snapshot.name} (${snapshot.imageName})`))
}

main().catch(console.error)

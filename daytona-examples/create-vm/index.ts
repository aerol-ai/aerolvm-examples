import { Daytona } from '@daytonaio/sdk'

// Initialize with configuration
const daytona = new Daytona({
  apiKey: 'slkvwieg423rn23r23n32unu23ngu23ng3u2ng',
  apiUrl: 'https://sandbox.aerol.cloud/daytona',
  target: 'us',
})

const sandbox = await daytona.create({
  snapshot: 'sumanrocs/penify-agent-with-docker:main-b249e3d',
})

const response = await sandbox.process.executeCommand('echo "Hello, World!"')
console.log(response.result)

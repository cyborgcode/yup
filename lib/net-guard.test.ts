import assert from 'node:assert/strict'
import {test} from 'node:test'
import {assertPublicUrl, isPrivateIp} from './net-guard'

test('flags loopback, private, link-local and mapped addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
})

test('lets public addresses through', () => {
  for (const ip of ['8.8.8.8', '142.250.72.14', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, ip)
  }
})

test('rejects non-http schemes and private hosts', async () => {
  await assert.rejects(assertPublicUrl('file:///etc/passwd'))
  await assert.rejects(assertPublicUrl('http://localhost:3000/'))
  await assert.rejects(assertPublicUrl('http://127.0.0.1:9001/2018-06-01/runtime/invocation/next'))
  await assert.rejects(assertPublicUrl('http://[::1]/'))
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data/'))
})

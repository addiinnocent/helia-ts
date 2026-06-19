#!/usr/bin/env node
/**
 * Clear the persisted libp2p peerstore from the S3 datastore.
 *
 * WHY THIS EXISTS
 * ---------------
 * libp2p persists *resolved* bootstrap addresses (e.g. /dns/sv15.bootstrap.libp2p.io/tcp/4001)
 * into the peerstore with a TTL. If the node is offline long enough for those addresses to
 * expire, the peer *record* still persists but with zero dialable addresses. On the next
 * start, bootstrap does not re-add the original /dnsaddr/ to the existing record, so every
 * bootstrap dial fails with `NoValidAddressesError` and the node stays isolated
 * (0 connected peers) — even though DNS and the network are fine.
 *
 * Clearing the `peers/` prefix removes only the stale peer cache. libp2p rebuilds it from
 * bootstrap + DHT within seconds. The node identity (info/self, pkcs8/self), pins
 * (pin/, pinned-block/) and datastore version are left untouched, so the peer ID and all
 * pinned content are preserved.
 *
 * USAGE
 * -----
 *   node --import tsx scripts/clear-peerstore.mjs
 *
 * Reads S3_DATA_BUCKET / S3_* credentials from the environment (same as the app).
 * Datastore path defaults to `.ipfs/datastore` (override with DATASTORE_PATH).
 */
import { getS3Client } from '../src/storage/s3-client.js'
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'

const bucket = process.env.S3_DATA_BUCKET || 'ramunap'
const datastorePath = process.env.DATASTORE_PATH || '.ipfs/datastore'
const prefix = `${datastorePath}/peers/`

const s3 = getS3Client()
let token
let deleted = 0

do {
  const out = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    ContinuationToken: token
  }))
  const objects = (out.Contents || []).map(o => ({ Key: o.Key }))
  if (objects.length > 0) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: objects, Quiet: true }
    }))
    deleted += objects.length
  }
  token = out.IsTruncated ? out.NextContinuationToken : undefined
} while (token)

console.log(`Cleared ${deleted} stale peerstore object(s) under ${bucket}/${prefix}`)
console.log('Node identity and pins were preserved. Restart the node to repopulate peers via bootstrap/DHT.')
process.exit(0)

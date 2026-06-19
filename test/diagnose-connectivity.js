import { getHeliaInstance, stopHeliaInstance, isHeliaRunning, getPeerCount, getConnectionDetails } from '../src/storage/helia.js'

/**
 * Diagnostic test for inbound/outbound connection analysis.
 *
 * Answers:
 * - Are we connecting to bootstrap peers? (outbound)
 * - Are other peers connecting to us? (inbound)
 * - Is our advertised multiaddress reachable?
 *
 * Run: npm test -- test/diagnose-connectivity.js
 */

async function diagnoseConnectivity () {
  console.log('\n=== Helia Connectivity Diagnostics ===\n')

  try {
    const helia = await getHeliaInstance()
    const libp2p = helia.libp2p

    // 1. Show advertised multiaddresses
    console.log('1. ADVERTISED MULTIADDRESSES:')
    const multiaddrs = libp2p.getMultiaddrs()
    if (multiaddrs.length === 0) {
      console.log('   ✗ No multiaddresses advertised!')
    } else {
      multiaddrs.forEach((addr, i) => {
        console.log(`   ${i + 1}. ${addr.toString()}`)
      })
    }

    // 2. Show connection status immediately
    console.log('\n2. IMMEDIATE CONNECTION STATUS:')
    console.log(`   Peer ID: ${libp2p.peerId.toString()}`)
    console.log(`   Total connected peers: ${getPeerCount()}`)

    const connections = getConnectionDetails()
    const inbound = connections.filter(c => c.direction === 'inbound')
    const outbound = connections.filter(c => c.direction === 'outbound')

    console.log(`   Inbound:  ${inbound.length}`)
    console.log(`   Outbound: ${outbound.length}`)

    if (inbound.length > 0) {
      console.log('\n   INBOUND CONNECTIONS:')
      inbound.forEach((conn, i) => {
        console.log(`     ${i + 1}. ${conn.peerId} from ${conn.remoteAddr}`)
      })
    }

    if (outbound.length > 0) {
      console.log('\n   OUTBOUND CONNECTIONS:')
      outbound.slice(0, 5).forEach((conn, i) => {
        console.log(`     ${i + 1}. ${conn.peerId} to ${conn.remoteAddr}`)
      })
      if (outbound.length > 5) {
        console.log(`     ... and ${outbound.length - 5} more`)
      }
    }

    // 3. Analysis
    console.log('\n3. CONNECTIVITY ANALYSIS:')

    if (inbound.length === 0 && outbound.length === 0) {
      console.log('   STATUS: ISOLATED')
      console.log('   - Node is not connected to any peers')
      console.log('   - Most common cause: a STALE PERSISTED PEERSTORE (not DNS).')
      console.log('     Fix: `npm run clear-peerstore` then restart, or ensure')
      console.log('     PEERSTORE_PRUNE_ON_START is not set to false.')
      console.log('   - See .md/BOOTSTRAP_TROUBLESHOOTING.md for full diagnosis.')
    } else if (inbound.length === 0 && outbound.length > 0) {
      console.log('   STATUS: OUTBOUND ONLY')
      console.log(`   - Node initiated ${outbound.length} connections`)
      console.log('   - No remote peers initiated connections to us')
      console.log('   - This is COMMON but may indicate:')
      console.log('     a) Other peers are unable to reach our multiaddresses')
      console.log('     b) Our multiaddress contains private IPs (127.0.0.1, 192.168.x.x)')
      console.log('     c) We are behind NAT/firewall without port forwarding')
      console.log('     d) The public internet peers prefer connecting outbound')
    } else if (inbound.length > 0) {
      console.log('   STATUS: BIDIRECTIONAL')
      console.log(`   - Inbound:  ${inbound.length} connections (other peers reached us)`)
      console.log(`   - Outbound: ${outbound.length} connections (we reached peers)`)
      console.log('   - This indicates good network reachability')
    }

    // 4. Recommendations
    console.log('\n4. RECOMMENDATIONS:')

    if (inbound.length === 0) {
      console.log('   For production use with inbound peers:')
      console.log('   a) Deploy on a public server with a static external IP')
      console.log('   b) Configure multiaddresses with the external IP/hostname')
      console.log('   c) Ensure port 4001 (TCP) is open to the internet')
      console.log('   d) Consider using DNSAddr for resilient multiaddresses')
    } else {
      console.log('   ✓ Inbound connectivity is working!')
      console.log('   Node is reachable from the public network')
    }

    // 5. Test with explicit wait for bootstrap
    console.log('\n5. WAITING FOR BOOTSTRAP (30 seconds)...')
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5000))
      const newCount = getPeerCount()
      const newConnections = getConnectionDetails()
      const newInbound = newConnections.filter(c => c.direction === 'inbound').length
      const newOutbound = newConnections.filter(c => c.direction === 'outbound').length
      console.log(`   +${i * 5}s: ${newCount} peers (${newInbound} in, ${newOutbound} out)`)
    }

    const finalConnections = getConnectionDetails()
    const finalInbound = finalConnections.filter(c => c.direction === 'inbound').length
    const finalOutbound = finalConnections.filter(c => c.direction === 'outbound').length

    console.log(`\n   Final: ${getPeerCount()} peers (${finalInbound} in, ${finalOutbound} out)`)

    console.log('\n=== End Diagnostics ===\n')

  } catch (error) {
    console.error('Error during diagnostics:', error.message)
  } finally {
    if (isHeliaRunning()) {
      await stopHeliaInstance()
    }
    process.exit(0)
  }
}

diagnoseConnectivity()

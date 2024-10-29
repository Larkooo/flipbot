import { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";
import { createClient, Entity, Subscription, ToriiClient } from "./libs/dojo.c/dojo_c";
import { ACTIONS_ADDRESS, TILE_MODEL_TAG, TORII_RELAY_URL, TORII_RPC_URL, TORII_URL, WORLD_ADDRESS } from "./constants";
import { useAccount, useConnect, useDisconnect } from "@starknet-react/core";
import { parseTileModel, Powerup } from "./utils";

interface FlipMetrics {
  totalFlips: number;
  successfulFlips: number;
  failedFlips: number;
  averageResponseTime: number;
  powerups: {
    [key in Powerup]: {
      count: number;
      values: number[];
    }
  };
  flipHistory: {
    timestamp: number;
    success: boolean;
    powerup?: Powerup;
    powerupValue?: number;
  }[];
}

function App() {
  const { account } = useAccount();
  const { connect, connectors } = useConnect();
  const cartridge = connectors[0];
  const { disconnect } = useDisconnect();
  const [client, setClient] = useState<ToriiClient | undefined>(undefined);
  const subscriptionRef = useRef<Subscription | undefined>(undefined);
  const [pendingFlips, setPendingFlips] = useState<{ x: number, y: number }[]>([]);
  const [isBotRunning, setIsBotRunning] = useState(false);
  const [txLogs, setTxLogs] = useState<{ hash: string, timestamp: number }[]>([]);
  const [chunkSize, setChunkSize] = useState<number>(10);
  const [executionDelay, setExecutionDelay] = useState<number>(100);
  const [metrics, setMetrics] = useState<FlipMetrics>({
    totalFlips: 0,
    successfulFlips: 0,
    failedFlips: 0,
    averageResponseTime: 0,
    powerups: {
      [Powerup.None]: { count: 0, values: [] },
      [Powerup.Multiplier]: { count: 0, values: [] }
    },
    flipHistory: []
  });
  const [tilePositions, setTilePositions] = useState<{
    pending: { x: number, y: number }[],
    flipped: { x: number, y: number }[]
  }>({
    pending: [],
    flipped: []
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [entityUpdateRate, setEntityUpdateRate] = useState<number[]>([]);
  const [lastUpdateTimestamp, setLastUpdateTimestamp] = useState<number>(Date.now());
  const updateRateInterval = useRef<ReturnType<typeof setInterval>>();
  const [sampleFactor, setSampleFactor] = useState<number>(1);

  const drawTiles = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Find the range of coordinates
    const allTiles = [...tilePositions.pending, ...tilePositions.flipped];
    if (allTiles.length === 0) return;
    
    const minX = Math.min(...allTiles.map(t => t.x));
    const maxX = Math.max(...allTiles.map(t => t.x));
    const minY = Math.min(...allTiles.map(t => t.y));
    const maxY = Math.max(...allTiles.map(t => t.y));
    
    // Calculate scaling factors
    const padding = 40;
    const scaleX = (canvas.width - padding * 2) / (maxX - minX + 1);
    const scaleY = (canvas.height - padding * 2) / (maxY - minY + 1);
    const scale = Math.min(scaleX, scaleY);
    
    // Drawing function
    const drawTile = (x: number, y: number) => {
      const screenX = padding + (x - minX) * scale;
      const screenY = padding + (y - minY) * scale;
      ctx.fillRect(screenX, screenY, Math.max(scale * 0.8, 2), Math.max(scale * 0.8, 2));
    };
    
    // Draw grid
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 0.5;
    for (let x = minX; x <= maxX; x++) {
      const screenX = padding + (x - minX) * scale;
      ctx.beginPath();
      ctx.moveTo(screenX, padding);
      ctx.lineTo(screenX, canvas.height - padding);
      ctx.stroke();
    }
    for (let y = minY; y <= maxY; y++) {
      const screenY = padding + (y - minY) * scale;
      ctx.beginPath();
      ctx.moveTo(padding, screenY);
      ctx.lineTo(canvas.width - padding, screenY);
      ctx.stroke();
    }
    
    // Draw tiles
    ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
    tilePositions.pending.forEach(({x, y}) => drawTile(x, y));
    
    ctx.fillStyle = 'rgba(0, 255, 0, 0.5)';
    tilePositions.flipped.forEach(({x, y}) => drawTile(x, y));
  }, [tilePositions]);

  useEffect(() => {
    updateRateInterval.current = setInterval(() => {
      const now = Date.now();
      const timeDiff = now - lastUpdateTimestamp;
      if (timeDiff > 0) {
        setEntityUpdateRate(prev => [...prev.slice(-29), 1000 / timeDiff]);
      }
      setLastUpdateTimestamp(now);
    }, 1000);

    return () => {
      if (updateRateInterval.current) {
        clearInterval(updateRateInterval.current);
      }
    };
  }, [lastUpdateTimestamp]);

  useEffect(() => {
    createClient({
      toriiUrl: TORII_URL,
        rpcUrl: TORII_RPC_URL,
        relayUrl: TORII_RELAY_URL,
        worldAddress: WORLD_ADDRESS,
      }).then((client) => {
        setClient(client);
      });
  }, []);

  useEffect(() => {
    if (!client) return;

    if (isBotRunning) {
      client.onEntityUpdated(
        [
          {
            Keys: {
              keys: [undefined],
              pattern_matching: "VariableLen",
              models: [TILE_MODEL_TAG],
            },
          },
        ],
        handleEntityUpdated
      ).then((subscription) => {
        subscriptionRef.current = subscription;
      });
    }

    return () => {
      subscriptionRef.current?.cancel();
    };
  }, [client, isBotRunning]);

  const handleEntityUpdated = async (hashedKeys: string, entity: Entity) => {
    setLastUpdateTimestamp(Date.now());
    if (!entity[TILE_MODEL_TAG]) return;
    const tile = parseTileModel(entity[TILE_MODEL_TAG], hashedKeys);
    
    // Check if this is a tile we flipped (has our address)
    if (tile.address === account?.address) {
      // Update metrics with powerup information
      setMetrics(prev => {
        const powerups = { ...prev.powerups };
        if (tile.powerup !== Powerup.None) {
          powerups[tile.powerup] = {
            count: (powerups[tile.powerup]?.count || 0) + 1,
            values: [...(powerups[tile.powerup]?.values || []), tile.powerupValue]
          };
        }

        return {
          ...prev,
          flipHistory: [
            ...prev.flipHistory,
            {
              timestamp: Date.now(),
              success: true,
              powerup: tile.powerup,
              powerupValue: tile.powerupValue
            }
          ].slice(-100), // Keep last 100 flips
          powerups
        };
      });
    }
    // Check if it's an available tile to flip
    if (tile.address === '0x0') {
      if (Math.random() < sampleFactor) {
        setPendingFlips(prev => [...prev, { x: tile.x, y: tile.y }]);
        setTilePositions(prev => ({
          ...prev,
          pending: [...prev.pending, { x: tile.x, y: tile.y }]
        }));
      }
    }
  };

  const executeFlips = async (flips: { x: number, y: number }[]) => {
    if (!account || flips.length === 0) return;

    const startTime = Date.now();
    try {
      const tx = await account.execute(
        flips.map(flip => ({
          contractAddress: ACTIONS_ADDRESS as string,
          entrypoint: 'flip',
          calldata: ['0x' + flip.x.toString(16), '0x' + flip.y.toString(16), '0x' + Math.floor(Math.random() * 6).toString(16)]
        }))
      );
      setTxLogs(prev => [...prev, { 
        hash: tx.transaction_hash, 
        timestamp: Date.now() 
      }].slice(-10));
      console.log(tx);
      
      // Update metrics with powerup information
      setMetrics(prev => {
        const newHistory = [
          ...prev.flipHistory,
          ...flips.map(() => ({
            timestamp: Date.now(),
            success: true,
            powerup: Powerup.None, // You'll need to get actual powerup info from tx response
            powerupValue: 0
          }))
        ].slice(-100); // Keep last 100 flips

        return {
          totalFlips: prev.totalFlips + flips.length,
          successfulFlips: prev.successfulFlips + flips.length,
          failedFlips: prev.failedFlips,
          averageResponseTime: (prev.averageResponseTime * prev.totalFlips + (Date.now() - startTime)) / (prev.totalFlips + flips.length),
          powerups: prev.powerups,
          flipHistory: newHistory
        };
      });
      
      // Update flipped positions
      setTilePositions(prev => ({
        pending: prev.pending.filter(p => !flips.some(f => f.x === p.x && f.y === p.y)),
        flipped: [...prev.flipped, ...flips]
      }));
      
    } catch (error) {
      setMetrics(prev => ({
        ...prev,
        totalFlips: prev.totalFlips + flips.length,
        failedFlips: prev.failedFlips + flips.length,
        flipHistory: [
          ...prev.flipHistory,
          ...flips.map(() => ({
            timestamp: Date.now(),
            success: false
          }))
        ].slice(-100)
      }));
      console.error('Transaction failed:', error);
    }
  };

  useEffect(() => {
    if (pendingFlips.length === 0) return;
    
    const timer = setTimeout(() => {
      const chunks = [];
      for (let i = 0; i < pendingFlips.length; i += chunkSize) {
        chunks.push(pendingFlips.slice(i, i + chunkSize));
      }
      
      chunks.forEach((chunk, index) => {
        setTimeout(() => {
          executeFlips(chunk);
        }, index * executionDelay);
      });
      
      setPendingFlips([]);
    }, 0);

    return () => clearTimeout(timer);
  }, [pendingFlips, account, chunkSize, executionDelay]);

  useEffect(() => {
    drawTiles();
  }, [tilePositions, drawTiles]);

  // Add new component for flip history graph
  const FlipHistoryGraph = () => {
    const successRate = metrics.flipHistory.reduce((acc, flip, idx, arr) => {
      if (idx < 10) return acc; // Need at least 10 samples
      const window = arr.slice(idx - 9, idx + 1);
      const rate = window.filter(f => f.success).length / 10;
      return [...acc, rate];
    }, [] as number[]);

    return (
      <div style={{ height: '50px', display: 'flex', alignItems: 'flex-end', gap: '2px' }}>
        {successRate.map((rate, i) => (
          <div
            key={i}
            style={{
              width: '3px',
              height: `${rate * 50}px`,
              backgroundColor: '#00cc00',
              opacity: (i + 1) / successRate.length
            }}
          />
        ))}
      </div>
    );
  };

  // Add new component for powerup distribution
  const PowerupDistribution = () => {
    const powerupData = Object.entries(metrics.powerups)
      .filter(([key]) => key !== Powerup.None.toString())
      .map(([key, data]) => ({
        type: Powerup[parseInt(key) as Powerup],
        count: data.count,
        avgValue: data.values.length > 0 
          ? data.values.reduce((a, b) => a + b, 0) / data.values.length 
          : 0
      }));

    return (
      <div style={{ marginTop: '10px' }}>
        {powerupData.map(({ type, count, avgValue }) => (
          <div key={type} style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{type}:</span>
            <span>{count} (avg: {avgValue.toFixed(1)})</span>
          </div>
        ))}
      </div>
    );
  };

  // Add a component to show powerup history
  const PowerupHistoryGraph = () => {
    const powerupHistory = metrics.flipHistory
      .filter(flip => flip.powerup !== undefined && flip.powerup !== Powerup.None)
      .slice(-30); // Show last 30 powerups

    return (
      <div style={{ 
        height: '50px', 
        display: 'flex', 
        alignItems: 'flex-end', 
        gap: '2px',
        marginTop: '10px' 
      }}>
        {powerupHistory.map((flip, i) => (
          <div
            key={i}
            style={{
              width: '3px',
              height: `${(flip.powerupValue || 0) / 255 * 50}px`,
              backgroundColor: flip.powerup === Powerup.Multiplier ? '#ff9900' : '#00cc00',
              opacity: (i + 1) / powerupHistory.length
            }}
            title={`${Powerup[flip.powerup!]}: ${flip.powerupValue}`}
          />
        ))}
      </div>
    );
  };

  return (
    <div style={{ padding: '20px' }}>
      <div>
        <button
          onClick={() => {
            if (account) disconnect();
            connect({ connector: cartridge });
          }}
        >
          {account ? "Disconnect" : "Connect"}
        </button>

        {account && (
          <button
            onClick={() => setIsBotRunning(!isBotRunning)}
            style={{ marginLeft: '10px' }}
          >
            {isBotRunning ? "Stop Bot" : "Start Bot"}
          </button>
        )}
      </div>

      {account && (
        <div style={{ 
          marginTop: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label htmlFor="chunkSize">Chunk Size:</label>
            <input
              type="range"
              id="chunkSize"
              min="1"
              max="20"
              value={chunkSize}
              onChange={(e) => setChunkSize(Number(e.target.value))}
            />
            <span>{chunkSize}</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label htmlFor="executionDelay">Delay (ms):</label>
            <input
              type="range"
              id="executionDelay"
              min="50"
              max="1000"
              step="50"
              value={executionDelay}
              onChange={(e) => setExecutionDelay(Number(e.target.value))}
            />
            <span>{executionDelay}ms</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label htmlFor="sampleFactor">Sample Factor:</label>
            <input
              type="range"
              id="sampleFactor"
              min="0"
              max="1"
              step="0.1"
              value={sampleFactor}
              onChange={(e) => setSampleFactor(Number(e.target.value))}
            />
            <span>{(sampleFactor * 100).toFixed(0)}%</span>
          </div>
        </div>
      )}

      {txLogs.length > 0 && (
        <div style={{ 
          marginTop: '20px',
          padding: '10px',
          border: '1px solid #ccc',
          borderRadius: '4px',
          maxHeight: '200px',
          overflowY: 'auto'
        }}>
          <h3>Recent Transactions</h3>
          {txLogs.map((tx, index) => (
            <div key={index} style={{ 
              fontSize: '14px',
              marginBottom: '8px',
              display: 'flex',
              justifyContent: 'space-between'
            }}>
              <a 
                href={`https://goerli.voyager.online/tx/${tx.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#0066cc' }}
              >
                {tx.hash.slice(0, 8)}...{tx.hash.slice(-6)}
              </a>
              <span style={{ color: '#666' }}>
                {new Date(tx.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}

      {account && (
        <>
          <div style={{
            marginTop: '20px',
            padding: '10px',
            border: '1px solid #ccc',
            borderRadius: '4px',
          }}>
            <h3>Metrics</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
              <div>
                <h4>Performance</h4>
                <div>Total Flips: {metrics.totalFlips}</div>
                <div>Successful: {metrics.successfulFlips}</div>
                <div>Failed: {metrics.failedFlips}</div>
                <div>Success Rate: {((metrics.successfulFlips / metrics.totalFlips) * 100 || 0).toFixed(1)}%</div>
                <div>Avg Response Time: {metrics.averageResponseTime.toFixed(2)}ms</div>
                <h4 style={{ marginTop: '10px' }}>Success Rate (last 10 flips)</h4>
                <FlipHistoryGraph />
              </div>
              <div>
                <h4>Entity Updates</h4>
                <div>Updates/sec: {entityUpdateRate.length > 0 ? entityUpdateRate[entityUpdateRate.length - 1].toFixed(1) : '0'}</div>
                <div style={{ 
                  height: '50px', 
                  display: 'flex', 
                  alignItems: 'flex-end',
                  gap: '2px',
                  marginTop: '10px'
                }}>
                  {entityUpdateRate.map((rate, i) => (
                    <div
                      key={i}
                      style={{
                        width: '3px',
                        height: `${Math.min(100, rate) / 100 * 50}px`,
                        backgroundColor: '#0066cc',
                        opacity: (i + 1) / entityUpdateRate.length
                      }}
                    />
                  ))}
                </div>
                <h4 style={{ marginTop: '10px' }}>Powerups</h4>
                <PowerupDistribution />
                <h4 style={{ marginTop: '10px' }}>Recent Powerups</h4>
                <PowerupHistoryGraph />
              </div>
            </div>
          </div>
          
          <div style={{
            marginTop: '20px',
            padding: '10px',
            border: '1px solid #ccc',
            borderRadius: '4px',
          }}>
            <h3>Tile Visualization</h3>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
              <div><span style={{ color: 'red' }}>■</span> Pending: {tilePositions.pending.length}</div>
              <div><span style={{ color: 'green' }}>■</span> Flipped: {tilePositions.flipped.length}</div>
            </div>
            <canvas 
              ref={canvasRef}
              width={400}
              height={400}
              style={{
                border: '1px solid #ccc',
                background: '#f5f5f5'
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

export default App;

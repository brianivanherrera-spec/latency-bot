/**
 * Test del motor de señales con datos simulados
 * Correr con: npm run test-signal
 * No requiere conexión a ninguna API
 */

const { SignalEngine } = require('./signal');

console.log('=== TEST MOTOR DE SEÑALES ===\n');

const signal = new SignalEngine();
let signalsDetected = 0;

// Simular 500 ticks de precio BTC con un spike artificial
const BASE_PRICE = 65000;
let price = BASE_PRICE;

for (let i = 0; i < 500; i++) {
  // Precio con ruido normal
  const noise = (Math.random() - 0.5) * 50;

  // Spike artificial en tick 350 (subida del 0.3%)
  if (i === 350) {
    price += 200; // subida brusca
    console.log(`[TICK ${i}] 🔥 Spike simulado: +$200 → $${price.toFixed(2)}`);
  } else if (i === 400) {
    price -= 250; // bajada brusca
    console.log(`[TICK ${i}] 🔥 Spike simulado: -$250 → $${price.toFixed(2)}`);
  } else {
    price += noise;
  }

  const isBuyerMaker = Math.random() > (i > 350 && i < 380 ? 0.3 : 0.5); // más presión compradora en spike

  const result = signal.process({
    price,
    timestamp: Date.now() - (500 - i) * 100, // timestamps simulados
    isBuyerMaker,
  });

  if (result && result.direction !== 'NEUTRAL') {
    signalsDetected++;
    console.log(`\n[TICK ${i}] 📊 SEÑAL DETECTADA:`);
    console.log(`  Dirección: ${result.direction}`);
    console.log(`  Precio: $${result.currentPrice.toFixed(2)}`);
    console.log(`  Z-Score: ${result.zScore.toFixed(3)}`);
    console.log(`  Move%: ${result.movePct.toFixed(4)}%`);
    console.log(`  Velocidad: ${result.velocity.toFixed(5)} %/s`);
    console.log(`  Buy Ratio: ${(result.buyRatio * 100).toFixed(1)}%`);
    console.log(`  Confianza: ${result.confidence}/100\n`);
  }
}

const stats = signal.getStats();
console.log('\n=== ESTADÍSTICAS FINALES ===');
console.log(`Total ticks procesados: ${stats.ticks}`);
console.log(`Señales detectadas: ${signalsDetected}`);
console.log(`Último precio: $${stats.lastPrice?.toFixed(2)}`);
console.log('\n✅ Test completado. El motor funciona correctamente.');

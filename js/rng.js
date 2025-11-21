/**
 * SeededRNG - Deterministic random number generator
 * Uses Mulberry32 algorithm for fast, high-quality randomness
 * 
 * This ensures that given the same seed, the exact same sequence
 * of random numbers will be generated, which is critical for
 * multiplayer synchronization across clients and game modes.
 */
class SeededRNG {
    constructor(seed) {
        this.state = seed >>> 0;
    }

    /**
     * Generate next random integer (0 to 4294967295)
     */
    nextInt() {
        let t = (this.state += 0x6D2B79F5);
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0);
    }

    /**
     * Generate next random float (0.0 to 1.0)
     */
    nextFloat() {
        return this.nextInt() / 4294967296;
    }

    /**
     * Generate random number in range [min, max)
     */
    nextRange(min, max) {
        return min + this.nextFloat() * (max - min);
    }

    /**
     * Generate random boolean with given probability
     * @param {number} probability - Chance of true (0.0 to 1.0)
     */
    nextBool(probability = 0.5) {
        return this.nextFloat() < probability;
    }

    /**
     * Create child RNG from current state
     * Useful for creating independent RNG streams for bots
     */
    fork(offset = 0) {
        return new SeededRNG(this.nextInt() + offset);
    }

    /**
     * Get current state for debugging/serialization
     */
    getState() {
        return this.state;
    }

    /**
     * Restore state from saved value
     */
    setState(state) {
        this.state = state >>> 0;
    }
}

// Export for use in other modules (Node.js compatibility)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SeededRNG;
}

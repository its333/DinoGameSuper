/**
 * SimClock - Shared simulation time coordinator
 * 
 * Ensures consistent delta progression across multiple runners
 * in the same game session (Local 2P, VS AI, Battle Royale).
 * 
 * Prevents timing drift while preserving responsive input handling
 * by providing a unified time source for obstacle generation and
 * bot decision-making.
 */
class SimClock {
    constructor(options = {}) {
        this.simTime = 0;           // Accumulated simulation time (ms)
        this.lastWallTime = 0;      // Last wall-clock timestamp
        this.deltaClamp = options.deltaClamp || 50;  // Max delta per tick (ms)
        this.isPaused = false;
        this.pausedAt = 0;
    }

    /**
     * Initialize the clock
     */
    start() {
        this.lastWallTime = performance.now();
        this.simTime = 0;
        this.isPaused = false;
    }

    /**
     * Update simulation time and return clamped delta
     * @param {number} wallTime - Current wall-clock time from performance.now()
     * @returns {number} Clamped delta in milliseconds
     */
    tick(wallTime) {
        if (this.isPaused) return 0;

        const rawDelta = wallTime - this.lastWallTime;
        const clampedDelta = Math.min(rawDelta, this.deltaClamp);

        this.simTime += clampedDelta;
        this.lastWallTime = wallTime;

        return clampedDelta;
    }

    /**
     * Pause simulation time accumulation
     * Useful for tab visibility changes
     */
    pause() {
        if (this.isPaused) return;
        this.isPaused = true;
        this.pausedAt = performance.now();
    }

    /**
     * Resume simulation time
     * Resets wall time to prevent delta spike
     */
    resume() {
        if (!this.isPaused) return;
        this.isPaused = false;
        // Reset lastWallTime to prevent delta spike after long pause
        this.lastWallTime = performance.now();
    }

    /**
     * Reset clock to initial state
     */
    reset() {
        this.simTime = 0;
        this.lastWallTime = 0;
        this.isPaused = false;
    }

    /**
     * Get current simulation time
     */
    getSimTime() {
        return this.simTime;
    }

    /**
     * Check if clock is paused
     */
    isClockPaused() {
        return this.isPaused;
    }
}

// Export for use in other modules (Node.js compatibility)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SimClock;
}

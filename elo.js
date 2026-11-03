'use strict';

function calculateEloGain(score, durationSeconds, rank, entryFee = 0) {
    let duration = Math.max(30, durationSeconds);
    let durationMinutes = duration / 60;
    let ppm = (score / durationMinutes);

    let baseGain = 0;
    let performanceBonus = 0;

    // Calculs de base et des rangs du Bronze au Pro
    if (rank === 'Bronze') {
        let effectiveExcess = score / (1 + Math.pow(score / 150000, 2));
        baseGain = Math.pow(effectiveExcess, 0.78) * 0.45;
        performanceBonus = Math.pow(effectiveExcess, 1.15) * 0.00002;
    } else if (rank === 'Silver') {
        let effectiveExcess = score / (1 + Math.pow(score / 150000, 2));
        baseGain = Math.pow(effectiveExcess, 0.78) * 0.35;
        performanceBonus = Math.pow(effectiveExcess, 1.18) * 0.000025;
    } else if (rank === 'Gold') {
        let effectiveExcess = score / (1 + Math.pow(score / 150000, 2));
        baseGain = Math.pow(effectiveExcess, 0.78) * 0.28;
        performanceBonus = Math.pow(effectiveExcess, 1.22) * 0.00003;
    } else if (rank === 'Diamond') {
        let effectiveExcess = score / (1 + Math.pow(score / 200000, 2.2));
        baseGain = Math.pow(effectiveExcess, 0.78) * 0.20;
        performanceBonus = Math.pow(effectiveExcess, 1.66) * 0.0000045;
    } else if (rank === 'Mythic') {
        let effectiveExcess = score / (1 + Math.pow(score / 400000, 2.3));
        baseGain = Math.pow(effectiveExcess, 0.75) * 0.16; 
        performanceBonus = Math.pow(effectiveExcess, 1.65) * 0.000003;
    } else if (rank === 'Legendary') {
        let effectiveExcess = score / (1 + Math.pow(score / 400000, 2.2));
        baseGain = Math.pow(effectiveExcess, 0.75) * 0.13; 
        performanceBonus = Math.pow(effectiveExcess, 1.67) * 0.0000018;
    } else if (rank === 'Master') {
        let effectiveExcess = score / (1 + Math.pow(score / 400000, 2));
        baseGain = Math.pow(effectiveExcess, 0.73) * 0.11; 
        performanceBonus = Math.pow(effectiveExcess, 1.7) * 0.0000012; 
    } else if (rank === 'Pro') {
        let effectiveExcess = score / (1 + Math.pow(score / 800000, 2.0));
        baseGain = Math.pow(effectiveExcess, 0.68) * 0.09; 
        performanceBonus = Math.pow(effectiveExcess, 1.75) * 0.0000005; 
    }

    let grossElo = baseGain + performanceBonus;
    let timeMultiplier = 1.0;
    
    // Le bloc PPM organique avec la courbe de sévérité adaptée du Diamant au Pro
    if (rank === 'Diamond' || rank === 'Mythic' || rank === 'Legendary' || rank === 'Master' || rank === 'Pro') {
        let idealMinutes = 0;

        if (rank === 'Diamond') {
            idealMinutes = 3 * Math.pow(score / 5000, 1.5);
        } else if (rank === 'Mythic') {
            idealMinutes = 2 * Math.pow(score / 5000, 1.48);
        } else if (rank === 'Legendary') {
            idealMinutes = 1.5 * Math.pow(score / 5000, 1.5);
        } else if (rank === 'Master') {
            idealMinutes = 0.5 * Math.pow(score / 5000, 2.1); 
        } else if (rank === 'Pro') {
            idealMinutes = 1.2 * Math.pow(score / 5000, 1.4); // ~50 minutes pour 80k points
        }

        let targetGlobalPpm = score / Math.max(0.5, idealMinutes);
        let efficiencyRatio = ppm / targetGlobalPpm;

        let rawTimeMultiplier = 1.0;
        if (efficiencyRatio < 1.0) {
            rawTimeMultiplier = Math.max(0.1, efficiencyRatio);
        }

        // Configuration par rang des seuils et des exposants de sévérité
        let targetThreshold = 15000;
        let protectionExponent = 1.2; // Diamant

        if (rank === 'Mythic') {
            targetThreshold = 30000;
            protectionExponent = 1.4;
        } else if (rank === 'Legendary') {
            targetThreshold = 30000;
            protectionExponent = 1.6;
        } else if (rank === 'Master') {
            targetThreshold = 50000;
            protectionExponent = 1.8;
        } else if (rank === 'Pro') {
            targetThreshold = 80000;
            protectionExponent = 1.6; // Adouci pour récompenser proprement les scores intermédiaires type 50k
        }

        // Application de la courbe convexe
        let scoreRatio = Math.min(1.0, score / targetThreshold);
        let scoreProtection = Math.pow(scoreRatio, protectionExponent);

        if (efficiencyRatio < 0.5 && score < (targetThreshold * 0.3)) {
            scoreProtection = 0; 
        }

        // Application fluide entre la pénalité de temps et le retour à la normale
        timeMultiplier = rawTimeMultiplier * (1.0 - scoreProtection) + 1.0 * scoreProtection;
    }

    let finalGross = grossElo * timeMultiplier;
    return Math.round(finalGross - entryFee);
}

module.exports = { calculateEloGain };

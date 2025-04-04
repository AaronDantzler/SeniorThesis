import { quantize } from '../../common/UtilityFunctions.js'
import Controller, {
    AnnouncementList,
    ControllerOutput,
    Measurement,
    TracedMeasurement
} from '../../types/Controller.js'
import { ModuleProfile } from '../../types/ModuleProfile.js'
import { ParameterDescriptions } from '../../types/ParametricModule.js'
import { PatientProfile } from '../../types/Patient.js'
import AbstractController from '../AbstractController.js'
import EventManager from '../EventManager.js'

export const profile: ModuleProfile = {
    type: "controller",
    id: "CSII",
    version: "2.1.0",
    name: "CSII with Meal Bolus",
}

export default class CSII
    extends AbstractController<typeof CSIIParameters>
    implements Controller {

    manager: EventManager = new EventManager()

    getModelInfo(): ModuleProfile {
        return profile
    }

    getParameterDescription() {
        return CSIIParameters
    }

    getI18n() {
        return { i18n_label, i18n_tooltip }
    }

    getInputList(): Array<keyof Measurement> {
        return ["CGM"]
    }

    getOutputList(): Array<keyof ControllerOutput> {
        return ["iir", "ibolus"]
    }

    autoConfigure(profile: PatientProfile) {

    }

    // Initialize an array to store past 12 BG values
    pastBG: number[] = Array(12).fill(0);

    update(t: Date, s: TracedMeasurement, announcements: AnnouncementList = {}) {
        const params = this.evaluateParameterValuesAt(t)
        const bg = Math.round(s.CGM?.() || s.SMBG?.() || NaN)

        // Shift past BG values and store the current BG at the front of the array
        this.pastBG.unshift(bg);
        if (this.pastBG.length > 12) {
            this.pastBG.pop(); // Keep only the most recent 12 BG values
        }

        // Check if we have enough non-zero values in pastBG (at least 12 non-zero values)
        const nonZeroBGCount = this.pastBG.filter(value => value > 0).length;

        // If not enough meaningful BG values, don't perform basal rate calculation yet
        if (nonZeroBGCount < 6) {
            return; // Skip calculation if we haven't accumulated 12 valid BG values
        }

        // ARX prediction: Model coefficients and intercept for BG prediction
        const modelCoefficients = [
            12.92870171, -18.80198439, 2.99096824, 6.5136452, -1.25945627,
            -2.77399766, 0.6878598, 1.31356547, -0.80004476, -0.77138137,
            1.14742972, -0.29668647
        ];
        const intercept = 21.663695641612946;

        // Perform ARX model prediction using the past 12 BG lags
        let predictedBG = intercept;
        for (let i = 0; i < this.pastBG.length; i++) {
            predictedBG += this.pastBG[i] * modelCoefficients[i];
        }

        // Log predicted BG (optional for debugging)
        console.log(`Predicted BG: ${predictedBG}`);

        // Only update basal rate every 5 minutes
        if (t.getMinutes() % 5 !== 0) {
            return;
        }

        // Basal rate calculation based on predicted BG with finer control
        let basalRate: number;
        if (predictedBG > 300) {
            basalRate = 4; // If BG > 300, basal = 4 U/h
        } else if (predictedBG >= 200) {
            basalRate = 2; // If BG between 200 and 300, basal = 2 U/h
        } else if (predictedBG >= 150) {
            basalRate = 1.5; // If BG between 150 and 200, basal = 1 U/h
        } else if (predictedBG >= 120) {
            basalRate = 0.7; // If BG between 120 and 150, basal = 0.7 U/h
        } else if (predictedBG >= 80) {
            basalRate = 0.5; // If BG between 80 and 120, basal = 0.5 U/h
        } else {
            basalRate = 0; // If BG < 80, basal = 0 U/h
        }

        this.output = { iir: quantize(basalRate, params.inc_basal) }

        // Meal bolus calculation (same as before)
        const upcomingIDs = this.manager.update(announcements, (uid) =>
            announcements[uid].start <= new Date(t.valueOf()
                + params.premealTime * 60e3))

        let ibolus = 0
        for (const id of upcomingIDs) {
            ibolus += announcements[id].carbs * params.carbFactor / 10
        }

        this.output.ibolus = ibolus
    }
}

export const CSIIParameters = {
    basalRate150: { unit: 'U/h', default: 1.0, min: 0, step: 0.1 },
    basalRate100: { unit: 'U/h', default: 0.7, min: 0, step: 0.1 },
    basalRateLow: { unit: 'U/h', default: 0, min: 0, step: 0.1 },
    inc_basal: { unit: 'U/h', default: 0.05, min: 0, step: 0.01 },
    carbFactor: { unit: 'U/(10g CHO)', default: 1, min: 0, step: 0.1 },
    premealTime: { unit: 'min', default: 30, step: 5 },
} satisfies ParameterDescriptions

export const i18n_label = {
    en: {
        "name": "CSII with Meal Bolus",
        "basalRate": "Basal rate",
        "inc_basal": "Increment",
        "carbFactor": "Carb factor",
        "premealTime": "Premeal time",
    },

    de: {
        "name": "CSII mit Mahlzeitenbolus",
        "basalRate": "Basalrate",
        "inc_basal": "Inkrement",
        "carbFactor": "KE-Faktor",
        "premealTime": "Spritz-Ess-Abstand",
    }
}

export const i18n_tooltip = {
    en: {
        "basalRate": "Basal rate means the amount of insulin per time that is continuously administered. It is measured in units per hour (U/h).",
        "inc_basal": "This is the difference between possible values of the basal rate. If it is greater than zero, the desired basal rate will be rounded.",
        "carbFactor": "The carb factor defines how much insulin is required to compensate for an amount of carbs.",
        "premealTime": "This defines how much before the meal a bolus is administered.",
    },

    de: {
        "basalRate": "Die Basalrate ist die kontinuierlich zugeführte Insulindosis pro Zeit. Sie wird in Einheiten pro Stunde (U/h) angegeben.",
        "inc_basal": "Der Abstand zwischen benachbarten Werten, die die Basalrate annehmen kann. Ist er größer als null, wird die Basalrate gerundet.",
        "carbFactor": "Der KE-Faktor beschreibt, wie viel Insulin benötigt wird, um eine Kohlenhydrateinheit (10g) auszugleichen.",
        "premealTime": "Der Spritz-Ess-Abstand legt fest, wie lange vor der Mahlzeit ein Bolus abgegeben wird.",
    }
}

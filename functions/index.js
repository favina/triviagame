'use strict';
process.env.DEBUG = 'actions-on-google:*';
const { DialogflowApp } = require('actions-on-google');
const functions = require('firebase-functions');
const firebaseAdmin = require('firebase-admin');

const firebaseConfig = functions.config().firebase;
firebaseAdmin.initializeApp(firebaseConfig);


// Logging dependencies
const winston = require('winston');
winston.loggers.add('DEFAULT_LOGGER', {
    console: {
        colorize: true,
        label: 'Default logger',
        json: false,
        timestamp: true
    }
});
const logger = winston.loggers.get('DEFAULT_LOGGER');
const { logObject } = require('./utils');
logger.transports.console.level = 'debug';

const Ssml = require('./ssml').SSML;
const { sprintf } = require('sprintf-js');
const utils = require('./utils');


const MAIN_INTENT = 'game.start';
const VALUE_INTENT = 'game.choice.value';
const UNKNOWN_INTENT = 'game.unknown';
const REPEAT_INTENT = 'game.question.repeat';
const SCORE_INTENT = 'game.score';
const HELP_INTENT = 'game.help';
const QUIT_INTENT = 'game.quit';
const NEW_INTENT = 'game.restart';
const ANSWERS_INTENT = 'game.answers';
const DONT_KNOW_INTENT = 'game.answers.dont_know';
const ORDINAL_INTENT = 'game.choice.ordinal';
const LAST_INTENT = 'game.choice.last';
const MIDDLE_INTENT = 'game.choice.middle';
const TRUE_INTENT = 'game.choice.true';
const FALSE_INTENT = 'game.choice.false';
const HINT_INTENT = 'game.hint';
const PLAY_AGAIN_CONTEXT = 'restart';
const PLAY_AGAIN_YES_INTENT = 'game.restart.yes';
const PLAY_AGAIN_NO_INTENT = 'game.restart.no';
const DONE_CONTEXT = 'quit';
const DONE_YES_INTENT = 'game.quit.yes';
const DONE_NO_INTENT = 'game.quit.no';
const HELP_CONTEXT = 'help';
const HELP_YES_INTENT = 'game.help.yes';
const HELP_NO_INTENT = 'game.help.no';
const UNKNOWN_DEEPLINK_ACTION = 'deeplink.unknown';
const RAW_TEXT_ARGUMENT = 'raw_text';
const DISAGREE_INTENT = 'game.answers.wrong';
const ANSWER_INTENT = 'game.choice.answer';
const ANSWER_ARGUMENT = 'answer';
const MISTAKEN_INTENT = 'game.mistaken';
const FEELING_LUCKY_INTENT = 'game.feeling_lucky';
const TRUE_FALSE_CONTEXT = 'true_false';
const ITEM_INTENT = 'game.choice.item';

const TTS_DELAY = '500ms';

const MAX_PREVIOUS_QUESTIONS = 100;
const SUGGESTION_CHIPS_MAX_TEXT_LENGTH = 25;
const SUGGESTION_CHIPS_MAX = 8;
const GAME_TITLE = 'The Fun Trivia Game';
const QUESTIONS_PER_GAME = 4;

// Firebase data keys

const DATABASE_QUESTIONS = 'json/questions';
const DATABASE_DATA = 'data/json';

const DATABASE_HIGHEST_SCORE = 'highestScore';
const DATABASE_LOWEST_SCORE = 'lowestScore';
const DATABASE_AVERAGE_SCORE = 'averageScore';
const DATABASE_TOTAL_SCORE = 'totalScore';
const DATABASE_SCORES = 'scores';
const DATABASE_VISITS = 'visits';
const DATABASE_ANSWERS = 'json/answers';


// Cloud Functions for Firebase entry point
exports.triviaGame = functions.https.onRequest((request, response) => {
    logger.info(logObject('trivia', 'handleRequest', {
        info: 'Handle request',
        headers: JSON.stringify(request.headers),
        body: JSON.stringify(request.body)
    }));

    const app = new DialogflowApp({request, response});


    let questions = [];
    let answers = [];
    let followUps = [];
    let gameLength = 4;
    let last = false;
    let middle = false;
    let ssmlNoInputPrompts;
    let questionPrompt;
    let selectedAnswers;
    let hasLastPrompt = false;

    var db = firebaseAdmin.database();
    var ref = db.ref("/json");


    const hasScreen = app.hasSurfaceCapability(app.SurfaceCapabilities.SCREEN_OUTPUT);
    logger.info(logObject('trivia', 'handleRequest', {
        info: 'Check screen capability',
        hasScreen: hasScreen
    }));



    // Select new questions, avoiding the previous questions
    const selectQuestions = (questions) => {
        logger.debug(logObject('trivia', 'post', {
            info: 'selectQuestions'
        }));
        if (!questions) {
            logger.error(logObject('trivia', 'post', {
                info: 'selectQuestions: No questions.'
            }));
            return null;
        }
        const selected = [];
        let i = 0;
        const checked = [];
        let index = 0;

        let found;
        // Select new questions, avoiding previous questions
        while (i < gameLength) {
            found = false;
            while (checked.length !== questions.length) {
                index = utils.getRandomNumber(0, questions.length - 1);
                if (selected.indexOf(index) === -1) {
                    selected.push(index);
                    i++;
                    found = true;
                    break;
                }
                if (checked.indexOf(index) === -1) {
                    checked.push(index);
                }
            }

        }

        logger.debug(logObject('trivia', 'post', {
            selected: JSON.stringify(selected)
        }));


        return selected;
    };

    // Select answers, using the index selected for the correct answer
    const selectAnswers = (correctIndex, answers) => {
        if (!answers) {
            logger.error(logObject('trivia', 'post', {
                info: 'selectAnswers: No answers.'
            }));
            return null;
        }
        const selected = [];
        if (answers.length > 1) {
            const clonedAnswers = answers.slice(1);

            for (let i = 0; i < answers.length; i++) {
                if (i === correctIndex) {
                    selected.push(answers[0]);
                } else {
                    const index = utils.getRandomNumber(0, clonedAnswers.length - 1);
                    selected.push(clonedAnswers[index]);
                    clonedAnswers.splice(index, 1);
                }
            }
        } else {
            logger.error(logObject('trivia', 'post', {
                info: 'selectAnswers: Not enough answers.',
                answers: answers.length
            }));
            return null;
        }
        logger.debug(logObject('trivia', 'selectAnswers', {
            info: 'Selected answers',
            selected: selected
        }));
        return selected;

    };

    // Start a new round of the game by selecting new questions
    const startNewRound = (callback) => {
        ref.on("value", function (snapshot) {
            questions = snapshot.val()['questions'];
            answers = snapshot.val()['answers'];
            const selectedQuestions = selectQuestions(questions);
            if (selectedQuestions) {
                const currentQuestion = 0;
                questionPrompt = questions[selectedQuestions[currentQuestion]];
                app.data.fallbackCount = 0;
                let correctIndex = 0;
                selectedAnswers = [];
                const selectedQuestionAnswers = answers[selectedQuestions[currentQuestion]];
                if (!(selectedQuestionAnswers)) {


                    correctIndex = utils.getRandomNumber(0, selectedQuestionAnswers.length - 1);
                    selectedAnswers = selectAnswers(correctIndex, selectedQuestionAnswers);
                    console.log(selectedAnswers);
                }
                if (selectedAnswers) {
                    const sessionQuestions = [];

                    for (let i = 0; i < selectedQuestions.length; i++) {
                        sessionQuestions.push(questions[selectedQuestions[i]]);
                    }



                    // Session data for the game logic
                    app.data.sessionQuestions = sessionQuestions;
                    app.data.selectedAnswers = selectedAnswers;
                    app.data.correctAnswer = correctIndex;

                    app.data.questionPrompt = questionPrompt;
                    app.data.score = 0;
                    app.data.currentQuestion = currentQuestion;
                    app.data.gameLength = gameLength;
                    app.data.fallbackCount = 0;
                    callback(null);
                } else {
                    callback(new Error('There is a problem with the answers.'));
                }
            } else {
                callback(new Error('Not enough questions.'));
            }



        });
};







// Main welcome intent handler
const mainIntent = (app) => {
    logger.info(logObject('trivia', 'mainIntent', {
        info: 'Handling main intent'
    }));

    startNewRound((error) => {
        if (error) {
            app.tell(error.message);
        } else {

            app.tell(questionPrompt);


        }
    });

};






const actionMap = new Map();
actionMap.set(MAIN_INTENT, mainIntent);


app.handleRequest(actionMap);
})

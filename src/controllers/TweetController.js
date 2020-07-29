import Twit from 'twit';
import dotenv from 'dotenv';
import regeneratorRuntime from "regenerator-runtime";
import { SentimentIntensityAnalyzer } from "vader-sentiment";

dotenv.config();

const SUPPORTED_LANGUAGES = {
    ar: 'Arabic',
    nl: 'Dutch',
    en: 'English',
    fa: 'Farsi',
    fr: 'French',
    de: 'German',
    id: 'Indonesian',
    it: 'Italian',
    ja: 'Japanese',
    pt: 'Portuguese',
    es: 'Spanish',
}

const clear_tweet = (text = '') => {
    let out = '';

    text.split(' ').forEach(word => {
        if (!word.startsWith('@')) {
            out += word.toLowerCase().replace(/#/g, '').replace(/@/g, 'a') + " ";
        }
    })

    return out.trim();
}

class TweetController {
    // instancia estatica com o objeto criado no construtor
    static instance;

    // cria uma instancia da classe
    constructor() {
        // cria o Twit que será usado na stream
        this.T = new Twit({
            consumer_key: process.env.TWITTER_API_KEY,
            consumer_secret: process.env.TWITTER_API_SECRET,
            access_token: process.env.TWITTER_ACCESS_TOKEN,
            access_token_secret: process.env.TWITTER_ACCESS_SECRET,
            timeout_ms: 60 * 1000, // timeout de 1 segundo
            strictSSL: true, // conectar com SSL
        });

        // propriedade que vai armazenar a stream
        this.stream = null;

        // dados dos tweets
        this.data = {
            hashtag: '',
            list: [],
            approved: [],
            rejected: [],
            watching: false,
            language: '',
            ai_enabled: false
        };

        // referencia pra criar os IDs unicos
        this.lastId = 0;

        // salva a instancia na propriedade estatica
        TweetController.instance = this;
    }

    // inicia o monitoramento de uma hashtag
    watch(req, res) {
        // se já não estiver monitorando
        if (!this.data.watching) {
            // pega a hashtag do request
            let { hashtag } = req.params;

            // adiciona o # se nao houver
            hashtag = hashtag.startsWith("#") ? hashtag : "#" + hashtag;

            // cria o filtro pra stream
            let query = {
                track: hashtag
            }
            // pega o idioma
            let language = req.query.lang;
            // se tiver selecao de idioma e for um dos idiomas disponiveis
            if (language && SUPPORTED_LANGUAGES[language]) {
                // adiciona ao filtro
                query.language = language;
                // adiciona aos dados
                this.data.language = language;
            }
            // cria a stream
            this.stream = this.T.stream('statuses/filter', query);

            // salva a hashtag nos dados
            this.data.hashtag = hashtag;
            // salva se esta monitorando nos dados
            this.data.watching = true;

            // adiciona o evento para cada tweet novo
            this.stream.on('tweet', tweet => {
                // se for um retweet ou não houver a hashtag no texto
                if (tweet.text.startsWith("RT") || !tweet.text.toUpperCase().includes(hashtag.toUpperCase())) {
                    return;
                }

                // se o tweet passa dos 140 caracteres
                const text = tweet.extended_tweet ? tweet.extended_tweet.full_text || tweet.text : tweet.text;

                // coloca um id pra ser usado nos requests
                tweet.id = ++this.lastId;

                // adiciona à lista geral
                const {
                    user: {
                        profile_image_url_https,
                        name,
                        screen_name,
                        id: user_id,
                        profile_image_url
                    }, id
                } = tweet;

                if (this.data.ai_enabled) {
                    const { compound } = SentimentIntensityAnalyzer.polarity_scores(clear_tweet(text))

                    if (compound >= 0.05) { // negativo
                        this.data.approved = [...this.data.approved, {
                            text, user: {
                                profile_image_url_https,
                                name,
                                screen_name,
                                id: user_id,
                                profile_image_url
                            }, id
                        }];
                    } else if (compound <= -0.05) {
                        this.data.rejected = [...this.data.rejected, {
                            text, user: {
                                profile_image_url_https,
                                name,
                                screen_name,
                                id: user_id,
                                profile_image_url
                            }, id
                        }];
                    } else {
                        this.data.list = [...this.data.list, {
                            text, user: {
                                profile_image_url_https,
                                name,
                                screen_name,
                                id: user_id,
                                profile_image_url
                            }, id
                        }];
                    }
                } else {
                    this.data.list = [...this.data.list, {
                        text, user: {
                            profile_image_url_https,
                            name,
                            screen_name,
                            id: user_id,
                            profile_image_url
                        }, id
                    }];
                }

                // emite o socket com os dados para o front end
                req.io.emit("change", this.data);
            });

            // emite o socket com os dados para o front end
            req.io.emit("change", this.data);
        }

        // retorna dizendo que funcionou
        return res.json({
            status: 1,
            data: this.data
        });
    };

    // para o monitoramento
    stop(req, res) {
        // se uma stream estiver sendo monitorada
        if (this.stream) {
            this.stream.stop();
            this.data.watching = false;

            req.io.emit("change", this.data);
        }

        // retorna dizendo que funcionou
        return res.json({
            status: 1,
        });
    };

    // limpa os tweets
    clear(req, res) {
        // se uma stream estiver sendo monitorada
        if (this.stream) {
            this.stream.stop();

            this.data = {
                hashtag: this.data.hashtag,
                list: [],
                approved: [],
                rejected: [],
                watching: false,
                language: this.data.language,
                ai_enabled: false
            };
            this.lastId = 0;

            req.io.emit("change", this.data);
        }

        // retorna dizendo que funcionou
        return res.json({
            status: 1,
        });
    };

    /**
     * Aprovar o tweet com o id selecionado. Escrita da forma mais otimizada para usar o mínimo de recursos.
     * @param {Request} req a requisicao
     * @param {Response} res a resposta
     */
    approve(req, res) {
        // pega o id do request
        const { id } = req.params;

        // loop pelos itens da lista geral
        for (const index in this.data.list) {
            const tweet = this.data.list[index];

            // se é o id selecionado
            if (tweet.id == id) {
                // adiciona aos aprovados
                this.data.approved = [tweet, ...this.data.approved];

                // remove da lista geral
                this.data.list.splice(index, 1);

                // emite o socket com a mudanca
                req.io.emit('change', this.data);

                // termina o request aqui dizendo que funcionou
                return res.json({
                    status: 1
                });
            }
        }

        // loop pelos itens da lista de aprovados
        for (const index in this.data.rejected) {
            const tweet = this.data.rejected[index];

            // se é o id selecionado
            if (tweet.id == id) {
                // adiciona aos aprovados
                this.data.approved = [tweet, ...this.data.approved];

                // remove da lista de aprovados
                this.data.rejected.splice(index, 1);

                // emite o socket com a mudanca
                req.io.emit('change', this.data);

                // termina o request aqui dizendo que funcionou
                return res.json({
                    status: 1
                });
            }
        }

        // nao encontrou o tweet
        return res.status(404).json({
            status: 0
        });
    }

    /**
     * Rejeitar o tweet com o id selecionado. Escrita da forma mais otimizada para usar o mínimo de recursos.
     * @param {Request} req a requisicao
     * @param {Response} res a resposta
     */
    reject(req, res) {
        // pega o id do request
        const { id } = req.params;

        // loop pelos itens da lista geral
        for (const index in this.data.list) {
            const tweet = this.data.list[index];

            // se é o id selecionado
            if (tweet.id == id) {
                // adiciona aos rejeitados
                this.data.rejected = [tweet, ...this.data.rejected];

                // remove da lista geral
                this.data.list.splice(index, 1);

                // emite o socket com a mudanca
                req.io.emit('change', this.data);

                // termina o request aqui dizendo que funcionou
                return res.json({
                    status: 1
                });
            }
        }

        // loop pelos itens da lista de aprovados
        for (const index in this.data.approved) {
            const tweet = this.data.approved[index];

            // se é o id selecionado
            if (tweet.id == id) {
                // adiciona aos rejeitados
                this.data.rejected = [tweet, ...this.data.rejected];

                // remove da lista de aprovados
                this.data.approved.splice(index, 1);

                // emite o socket com a mudanca
                req.io.emit('change', this.data);

                // termina o request aqui dizendo que funcionou
                return res.json({
                    status: 1
                });
            }
        }

        // nao encontrou o tweet
        return res.status(404).json({
            status: 0
        });
    }

    /**
     * Apaga o tweet com o id selecionado. Escrita da forma mais otimizada para usar o mínimo de recursos.
     * @param {Request} req a requisicao
     * @param {Response} res a resposta
     */
    delete(req, res) {
        // pega o id do request
        const { id } = req.params;

        // loop pelos itens da lista geral
        for (const index in this.data.list) {
            const tweet = this.data.list[index];

            // se é o id selecionado
            if (tweet.id == id) {
                // remove da lista geral
                this.data.list.splice(index, 1);

                // emite o socket com a mudanca
                req.io.emit('change', this.data);

                // termina o request aqui dizendo que funcionou
                return res.json({
                    status: 1
                });
            }
        }

        // loop pelos itens da lista de aprovados
        for (const index in this.data.approved) {
            const tweet = this.data.approved[index];

            // se é o id selecionado
            if (tweet.id == id) {
                // remove da lista de aprovados
                this.data.approved.splice(index, 1);

                // emite o socket com a mudanca
                req.io.emit('change', this.data);

                // termina o request aqui dizendo que funcionou
                return res.json({
                    status: 1
                });
            }
        }

        // loop pelos itens da lista de rejeitados
        for (const index in this.data.rejected) {
            const tweet = this.data.rejected[index];

            // se é o id selecionado
            if (tweet.id == id) {
                // remove da lista de rejeitados
                this.data.rejected.splice(index, 1);

                // emite o socket com a mudanca
                req.io.emit('change', this.data);

                // termina o request aqui dizendo que funcionou
                return res.json({
                    status: 1
                });
            }
        }

        // nao encontrou o tweet
        return res.status(404).json({
            status: 0
        });
    }

    /**
     * Habilita a auto-aprovação de tweets por IA
     * @param {Request} req a requisicao
     * @param {Response} res a resposta
     */
    enable_ai(req, res) {
        this.data.ai_enabled = true;
        req.io.emit('change', this.data);

        return res.status(200).json({
            status: 1
        });
    }

    /**
     * Habilita a auto-aprovação de tweets por IA
     * @param {Request} req a requisicao
     * @param {Response} res a resposta
     */
    disable_ai(req, res) {
        this.data.ai_enabled = false;
        req.io.emit('change', this.data);

        return res.status(200).json({
            status: 1
        });
    }
}

export default TweetController;
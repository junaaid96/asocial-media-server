const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
// const jwt = require("jsonwebtoken");
require("dotenv").config();
const port = process.env.PORT || 5000;

const app = express();

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster1.rvctvez.mongodb.net/?retryWrites=true&w=majority`;

// middleware
app.use(cors());
app.use(express.json());

// database connection
const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverApi: ServerApiVersion.v1,
});

async function run() {
    try {
        await client.connect();
        console.log("Connected correctly to server");
        const db = client.db("aSocial");
        const usersCollection = db.collection("users");
        const mediaCollection = db.collection("media");

        // signup
        app.post("/users", async (req, res) => {
            const { username, email, institute, address, photo } = req.body;
            const user = await usersCollection.findOne({ email });
            if (user) {
                res.status(400).send({
                    message: "User already exists",
                });
            } else {
                const newUser = {
                    username,
                    email,
                    institute,
                    address,
                    photo,
                };
                await usersCollection.insertOne(newUser);
                res.status(200).send({
                    message: "User created successfully",
                });
            }
        });

        //user create a post
        app.post("/posts", async (req, res) => {
            const { username, email, writings, photo } = req.body;
            const newPost = {
                username,
                email,
                writings,
                photo,
            };
            await mediaCollection.insertOne(newPost);
            res.status(200).send({
                message: "Post created successfully",
            });
        });

        // get a user
        app.get("/user/:email", async (req, res) => {
            const { email } = req.params;
            const user = await usersCollection.findOne({ email });
            if (user) {
                res.status(200).send(user);
            } else {
                res.status(404).send({
                    message: "User not found",
                });
            }
        });

        //update a user
        app.patch("/user/:email", async (req, res) => {
            const email = req.params.email;
            const filter = { email: email };
            const options = { upsert: true };
            const updates = req.body;
            const update = {
                $set: updates,
            };
            await usersCollection.updateOne(filter, update, options);
            res.status(200).send({
                message: "User updated",
            });
        });
    } finally {
    }
}
run().catch(console.log);

app.get("/", (req, res) => {
    res.send("aSocial server is running");
});

app.listen(port, () => console.log(`aSocial running on ${port}`));

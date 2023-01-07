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
        console.log("Connected correctly to server");
        const db = client.db("aSocial");
        const usersCollection = db.collection("users");
        const mediaCollection = db.collection("media");
        const commentsCollection = db.collection("comments");

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

        // get all users
        app.get("/users", async (req, res) => {
            const users = await usersCollection.find().toArray();
            res.send(users);
        });

        //update a user
        app.patch("/user/:email", async (req, res) => {
            const email = req.params.email;
            const filter = { email: email };
            const option = { upsert: true };
            const update = {
                $set: {
                    username: req.body.username,
                    institute: req.body.institute,
                    address: req.body.address,
                    isUpdated: true,
                },
            };
            // Find the user with the given email
            const user = await usersCollection.findOne({ email: email });
            // Check if the user has actually changed the username
            if (req.body.username !== user.username) {
                // Check if a user with the same username already exists
                const existingUser = await usersCollection.findOne({
                    username: req.body.username,
                });
                if (existingUser) {
                    return res
                        .status(400)
                        .send({ error: "Username already exists" });
                }
            }

            await usersCollection.updateOne(filter, update, option);
            res.status(200).send({ message: "User updated" });
        });

        // get user's posts
        app.get("/posts/:email", async (req, res) => {
            const { email } = req.params;
            const sort = { _id: -1 };
            const posts = await mediaCollection
                .find({ email })
                .sort(sort)
                .toArray();
            res.send(posts);
        });

        // get all posts
        app.get("/posts", async (req, res) => {
            const sort = { _id: -1 };
            const posts = await mediaCollection.find().sort(sort).toArray();
            res.send(posts);
        });

        // update existing post username
        app.patch("/posts/:email", async (req, res) => {
            const email = req.params.email;
            const filter = { email: email };
            const update = {
                $set: {
                    username: req.body.username,
                },
            };
            await mediaCollection.updateMany(filter, update);
            res.status(200).send({
                message: "username updated",
            });
        });

        //edit a post
        app.patch("/post/:id", async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const option = { upsert: true };
            const update = {
                $set: {
                    writings: req.body.writings,
                    isUpdated: true,
                },
            };
            await mediaCollection.updateOne(filter, update, option);
            res.status(200).send({
                message: "Post updated",
            });
        });

        // delete a post
        app.delete("/post/:id", async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            await mediaCollection.deleteOne(filter);
            res.status(200).send({
                message: "Post deleted",
            });
        });

        // add a comment
        app.post("/comments", async (req, res) => {
            const { post_id, username, email, comment } = req.body;
            const newComment = {
                post_id,
                username,
                email,
                comment,
            };
            await commentsCollection.insertOne(newComment);
            res.status(200).send({
                message: "Comment added",
            });
        });

        // get all comments
        app.get("/comments/:id", async (req, res) => {
            const id = req.params.id;
            const comments = await commentsCollection
                .find({ post_id: id })
                .toArray();
            res.send(comments);
        });

        // delete a comment
        app.delete("/comment/:id", async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            await commentsCollection.deleteOne(filter);
            res.status(200).send({
                message: "Comment deleted",
            });
        });

        // update existing comment username
        app.patch("/comments/:email", async (req, res) => {
            const email = req.params.email;
            const filter = { email: email };
            const update = {
                $set: {
                    username: req.body.username,
                },
            };
            await commentsCollection.updateMany(filter, update);
            res.status(200).send({
                message: "username updated",
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

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
        console.log("Connected correctly to the server");
        const db = client.db("aSocial");
        const usersCollection = db.collection("users");
        const mediaCollection = db.collection("media");
        const commentsCollection = db.collection("comments");
        const likesCollection = db.collection("likes");

        // signup
        app.post("/users", async (req, res) => {
            const { username, email, institute, address, photo } = req.body;
            const user = await usersCollection.findOne({
                $or: [{ email }, { username }],
            });
            if (user) {
                res.status(400).send({
                    message: "Username or email already exists",
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

        // get a user by email
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

        //get a user by username
        app.get("/user/username/:username", async (req, res) => {
            const { username } = req.params;
            const user = await usersCollection.findOne({ username });
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

        // Get popular posts based on like count
        app.get("/posts/popular", async (req, res) => {
            try {
                const posts = await mediaCollection
                    .aggregate([
                        {
                            $lookup: {
                                from: "likes",
                                localField: "_id",
                                foreignField: "post_id",
                                as: "likes",
                            },
                        },
                        {
                            $addFields: {
                                likesCount: { $size: "$likes" },
                            },
                        },
                        {
                            $sort: { likesCount: -1 },
                        },
                        {
                            $limit: 3,
                        },
                    ])
                    .toArray();
                res.send(posts);
            } catch (error) {
                console.error("Error in popular posts:", error);
                res.status(500).send({ message: error.message });
            }
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

        // get all posts with pagination
        app.get("/posts", async (req, res) => {
            try {
                const page = parseInt(req.query.page) || 1;
                const limit = parseInt(req.query.limit) || 5;
                const skip = (page - 1) * limit;

                const totalPosts = await mediaCollection.countDocuments();

                // Sort by createdAt in descending order (-1) to get newest posts first
                const posts = await mediaCollection
                    .find({})
                    .sort({ createdAt: -1, _id: -1 }) // -1 means descending order
                    .skip(skip)
                    .limit(limit)
                    .toArray();

                res.status(200).send({
                    posts,
                    totalPages: Math.ceil(totalPosts / limit),
                    currentPage: page,
                    totalPosts,
                });
            } catch (error) {
                console.error("Error fetching posts:", error);
                res.status(500).send({ message: "Error fetching posts" });
            }
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
                    updatedAt: new Date(),
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
                createdAt: new Date(),
            };
            await commentsCollection.insertOne(newComment);
            res.status(200).send({
                message: "Comment added",
            });
        });

        // Edit a comment
        app.patch("/comment/:id", async (req, res) => {
            const id = req.params.id;
            const { comment } = req.body;
            const filter = { _id: ObjectId(id) };
            const option = { upsert: true };
            const update = {
                $set: {
                    comment: comment,
                    updatedAt: new Date(),
                },
            };
            await commentsCollection.updateOne(filter, update, option);
            res.status(200).send({
                message: "Comment updated",
            });
        });

        //user create a post
        app.post("/posts", async (req, res) => {
            const { username, email, writings, photo } = req.body;
            const newPost = {
                username,
                email,
                writings,
                photo,
                createdAt: new Date(),
            };
            await mediaCollection.insertOne(newPost);
            res.status(200).send({
                message: "Post created successfully",
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

        // add a like
        app.post("/likes", async (req, res) => {
            const { post_id, email } = req.body;
            const newLike = {
                post_id,
                email,
            };
            await likesCollection.insertOne(newLike);
            res.status(200).send({
                message: "Like added",
            });
        });

        // remove a like
        app.delete("/like/:id", async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            await likesCollection.deleteOne(filter);
            res.status(200).send({
                message: "Like removed",
            });
        });

        // Get the count of likes for a post
        app.get("/likes/count/:postId", async (req, res) => {
            const { postId } = req.params;
            const count = await likesCollection.countDocuments({
                post_id: postId,
            });
            res.send({ count });
        });

        // Check if a user has liked a post
        app.get("/likes/:postId/:email", async (req, res) => {
            const { postId, email } = req.params;
            const like = await likesCollection.findOne({
                post_id: postId,
                email: email,
            });

            if (like) {
                res.send({ liked: true, _id: like._id });
            } else {
                res.send({ liked: false });
            }
        });
    } finally {
        // Empty finally block
    }
}
run().catch(console.log);

app.get("/", (req, res) => {
    res.send("aSocial server is running");
});

app.listen(port, () => console.log(`aSocial running on ${port}`));

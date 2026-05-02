import express from 'express';
import Order from '../models/Order.js';
import Table from '../models/Table.js';
import { authenticate } from '../middleware/auth.js';
import { 
  notifyKitchenNewOrder, 
  notifyKitchenOrderModified, 
  notifyKitchenInstantOrder,
  notifyOrderReady,
  notifyCancellationRequest
} from './notifications.js';

const router = express.Router();

// Helper to generate unique table session ID
const generateTableSessionId = (tableNumber) => {
  return `table_${tableNumber}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// Helper function to update table status
const updateTableStatusFromOrders = async (tableNumber, io) => {
  if (!tableNumber) return 0;
  
  const activeOrdersCount = await Order.countDocuments({
    tableNumber: tableNumber,
    status: { $in: ['pending', 'accepted', 'preparing', 'hold', 'ready_for_billing'] },
    'payment.status': { $ne: 'paid' }
  });
  
  const table = await Table.findOne({ tableNumber: tableNumber });
  
  if (table) {
    const newStatus = activeOrdersCount > 0 ? 'running' : 'available';
    table.status = newStatus;
    table.runningOrderCount = activeOrdersCount;
    
    if (activeOrdersCount === 0) {
      table.currentSessionId = null;
      table.baseOrderNumber = null;
    }
    
    await table.save();
    
    if (io) {
      io.emit('table-status-changed', { 
        tableNumber, 
        status: newStatus, 
        runningOrderCount: activeOrdersCount 
      });
    }
  }
  
  return activeOrdersCount;
};

// Get all orders
router.get('/', authenticate, async (req, res) => {
  try {
    const orders = await Order.find({}).sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get active orders for a specific table
router.get('/table/:tableNumber/active', authenticate, async (req, res) => {
  try {
    const tableNumber = parseInt(req.params.tableNumber);
    const activeOrders = await Order.find({
      tableNumber: tableNumber,
      status: { $in: ['pending', 'accepted', 'preparing', 'hold', 'ready_for_billing'] },
      'payment.status': { $ne: 'paid' }
    }).sort({ runningNumber: 1 });
    
    res.json(activeOrders);
  } catch (error) {
    console.error('Error fetching table orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get order by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: error.message });
  }
});

// UPDATE ORDER - For changing order type, table number, delivery platform
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const { orderType, tableNumber, deliveryPlatform } = req.body;
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    console.log(`Updating order ${order.displayOrderNumber}:`, { orderType, tableNumber, deliveryPlatform });
    
    // Update order type if provided
    if (orderType && orderType !== order.orderType) {
      order.orderType = orderType;
      
      // Clear irrelevant fields based on new order type
      if (orderType === 'dine-in') {
        if (tableNumber !== undefined) {
          order.tableNumber = parseInt(tableNumber);
        }
        order.deliveryPlatform = null;
      } else if (orderType === 'takeaway') {
        order.tableNumber = null;
        order.deliveryPlatform = null;
      } else if (orderType === 'delivery') {
        order.tableNumber = null;
        if (deliveryPlatform) {
          order.deliveryPlatform = deliveryPlatform;
        }
      }
    } else {
      // If only table number changed for dine-in
      if (tableNumber !== undefined && order.orderType === 'dine-in') {
        order.tableNumber = parseInt(tableNumber);
      }
      
      // If only delivery platform changed for delivery
      if (deliveryPlatform !== undefined && order.orderType === 'delivery') {
        order.deliveryPlatform = deliveryPlatform;
      }
    }
    
    order.updatedAt = new Date();
    await order.save();
    
    console.log(`Order ${order.displayOrderNumber} updated successfully`);
    
    const io = req.app.get('io');
    if (io) {
      io.emit('order-updated', order);
    }
    
    res.json(order);
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: error.message });
  }
});

// CHANGE PAYMENT METHOD - For completed orders
router.patch('/:id/change-payment', authenticate, async (req, res) => {
  try {
    const { paymentMethod, reason } = req.body;
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    // Validate payment method
    const validMethods = ['cash', 'card', 'upi', 'credit'];
    if (!validMethods.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }
    
    const oldMethod = order.payment?.method || 'pending';
    
    // Update payment method
    order.payment = {
      ...order.payment,
      method: paymentMethod,
      status: paymentMethod === 'credit' ? 'credit_due' : 'paid',
      timestamp: new Date(),
      notes: order.payment?.notes 
        ? `${order.payment.notes}\nPayment method changed from ${oldMethod} to ${paymentMethod}. Reason: ${reason || 'Manual correction'}`
        : `Payment method changed from ${oldMethod} to ${paymentMethod}. Reason: ${reason || 'Manual correction'}`
    };
    
    order.updatedAt = new Date();
    await order.save();
    
    console.log(`Payment method changed for Order ${order.displayOrderNumber}: ${oldMethod} -> ${paymentMethod}`);
    
    const io = req.app.get('io');
    if (io) {
      io.emit('order-updated', order);
    }
    
    res.json(order);
  } catch (error) {
    console.error('Error changing payment method:', error);
    res.status(500).json({ error: error.message });
  }
});

// CREDIT LEDGER - Get all credit due orders for a customer
router.get('/credit-ledger/:customerId', authenticate, async (req, res) => {
  try {
    const { customerId } = req.params;
    
    const orders = await Order.find({
      'payment.method': 'credit',
      'payment.status': 'credit_due',
      $or: [
        { 'payment.customerId': customerId },
        { 'payment.customerName': { $regex: customerId, $options: 'i' } },
        { 'customer.name': { $regex: customerId, $options: 'i' } }
      ],
      status: { $ne: 'cancelled' }
    }).sort({ createdAt: -1 });
    
    res.json(orders);
  } catch (error) {
    console.error('Error fetching credit ledger:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET ALL CREDIT CUSTOMERS WITH TOTAL DUE - For Credit Ledger Modal
router.get('/credit-customers', authenticate, async (req, res) => {
  try {
    const creditOrders = await Order.find({
      'payment.method': 'credit',
      'payment.status': 'credit_due',
      status: { $ne: 'cancelled' }
    }).sort({ createdAt: -1 });
    
    const customersMap = new Map();
    
    creditOrders.forEach(order => {
      // Get customer name from various sources
      let customerName = null;
      let customerPhone = null;
      let customerId = null;
      
      if (order.customer && order.customer.name) {
        customerName = order.customer.name;
        customerPhone = order.customer.phone || '';
        customerId = order.customer._id || order.customer.name;
      } else if (order.payment && order.payment.customerName) {
        customerName = order.payment.customerName;
        customerPhone = order.payment.customerPhone || '';
        customerId = order.payment.customerId || customerName;
      }
      
      // Skip if no customer name or it's a generic name
      if (!customerName || customerName === 'Walk-In' || customerName === 'Unknown Customer') {
        return;
      }
      
      const key = customerId || customerName;
      
      if (!customersMap.has(key)) {
        customersMap.set(key, {
          customerId: key,
          customerName: customerName,
          customerPhone: customerPhone,
          totalDue: 0,
          orders: []
        });
      }
      
      const customer = customersMap.get(key);
      customer.totalDue += order.total || 0;
      customer.orders.push({
        _id: order._id,
        orderNumber: order.orderNumber,
        displayOrderNumber: order.displayOrderNumber,
        total: order.total,
        createdAt: order.createdAt,
        dueDate: order.payment?.dueDate,
        items: order.items,
        subtotal: order.subtotal,
        tax: order.tax,
        serviceCharge: order.serviceCharge,
        customerName: customerName,
        customerPhone: customerPhone,
        orderType: order.orderType,
        tableNumber: order.tableNumber
      });
    });
    
    res.json(Array.from(customersMap.values()));
  } catch (error) {
    console.error('Error fetching credit customers:', error);
    res.status(500).json({ error: error.message });
  }
});

// PROCESS CREDIT COLLECTION - Partial payment collection
router.post('/credit-collection', authenticate, async (req, res) => {
  try {
    const { customerId, amount, paymentMethod, note, collectedBy } = req.body;
    
    if (!customerId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid request' });
    }
    
    // Find all credit orders for this customer that are still due
    const creditOrders = await Order.find({
      $or: [
        { 'customer.name': customerId },
        { 'customer._id': customerId },
        { 'payment.customerName': customerId },
        { 'payment.customerId': customerId }
      ],
      'payment.method': 'credit',
      'payment.status': 'credit_due',
      status: { $ne: 'cancelled' }
    }).sort({ createdAt: 1 });
    
    let remainingAmount = amount;
    const updatedOrders = [];
    
    for (const order of creditOrders) {
      if (remainingAmount <= 0) break;
      
      const orderDue = order.total;
      
      if (remainingAmount >= orderDue) {
        // Full payment for this order
        order.payment.status = 'paid';
        order.payment.collectedAt = new Date();
        order.payment.collectedAmount = orderDue;
        order.payment.collectionMethod = paymentMethod;
        order.payment.collectionNote = note;
        order.status = 'completed';
        order.completedAt = new Date();
        remainingAmount -= orderDue;
        updatedOrders.push({ 
          orderId: order._id, 
          orderNumber: order.displayOrderNumber || order.orderNumber,
          amount: orderDue, 
          status: 'fully_paid' 
        });
      } else {
        // Partial payment - update order total
        const newTotal = orderDue - remainingAmount;
        
        // Create a record of partial payment
        if (!order.payment.partialPayments) {
          order.payment.partialPayments = [];
        }
        order.payment.partialPayments.push({
          amount: remainingAmount,
          method: paymentMethod,
          note: note,
          collectedAt: new Date(),
          collectedBy: collectedBy
        });
        
        order.total = newTotal;
        order.subtotal = newTotal - (order.tax + order.serviceCharge);
        order.payment.amount = newTotal;
        order.payment.remainingDue = newTotal;
        
        updatedOrders.push({ 
          orderId: order._id, 
          orderNumber: order.displayOrderNumber || order.orderNumber,
          amount: remainingAmount, 
          status: 'partial_paid', 
          remainingDue: newTotal 
        });
        remainingAmount = 0;
      }
      
      await order.save();
    }
    
    const io = req.app.get('io');
    if (io) {
      io.emit('credit-collection-updated', { customerId, amount, updatedOrders });
    }
    
    res.json({
      success: true,
      message: `Collected ₹${amount}`,
      updatedOrders,
      remainingAmount
    });
  } catch (error) {
    console.error('Error processing credit collection:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new order
router.post('/', authenticate, async (req, res) => {
  try {
    const orderData = req.body;
    
    // REMOVE any _id that might come from frontend
    delete orderData._id;
    delete orderData.id;
    
    let baseOrderNumber;
    let runningNumber;
    let tableSessionId;
    let isAdditionalOrder = false;
    
    console.log('📝 Creating order:', JSON.stringify(orderData, null, 2));
    
    // Handle table session for dine-in orders
    if (orderData.orderType === 'dine-in' && orderData.tableNumber) {
      let table = await Table.findOne({ tableNumber: orderData.tableNumber });
      
      if (!table) {
        table = new Table({
          tableNumber: orderData.tableNumber,
          status: 'available',
          capacity: 4
        });
        await table.save();
      }
      
      // Check if table has an active session (running orders)
      if (table.status === 'running' && table.currentSessionId && table.baseOrderNumber) {
        // Additional order for existing table session
        tableSessionId = table.currentSessionId;
        isAdditionalOrder = true;
        baseOrderNumber = table.baseOrderNumber;
        runningNumber = table.runningOrderCount;
        
        console.log(`📝 Additional order for table ${orderData.tableNumber}: baseOrderNumber=${baseOrderNumber}, runningNumber=${runningNumber}`);
      } else {
        // FIRST ORDER AFTER TABLE IS AVAILABLE - Start new session
        tableSessionId = generateTableSessionId(orderData.tableNumber);
        isAdditionalOrder = false;
        runningNumber = 0;
        
        // Generate NEW base order number
        const lastOrder = await Order.findOne().sort({ baseOrderNumber: -1 });
        baseOrderNumber = lastOrder ? lastOrder.baseOrderNumber + 1 : 1000000;
        
        // Update table with new session
        table.currentSessionId = tableSessionId;
        table.baseOrderNumber = baseOrderNumber;
        table.status = 'running';
        table.runningOrderCount = 1;
        await table.save();
        
        console.log(`📝 NEW SESSION - First order for table ${orderData.tableNumber}: baseOrderNumber=${baseOrderNumber}`);
      }
    } else {
      // Non dine-in orders
      const lastOrder = await Order.findOne().sort({ baseOrderNumber: -1 });
      baseOrderNumber = lastOrder ? lastOrder.baseOrderNumber + 1 : 1000000;
      runningNumber = 0;
    }
    
    const displayOrderNumber = runningNumber === 0 ? `${baseOrderNumber}` : `${baseOrderNumber}-${runningNumber}`;
    
    // Create order
    const order = new Order({
      ...orderData,
      baseOrderNumber,
      runningNumber,
      displayOrderNumber,
      tableSessionId,
      isAdditionalOrder,
      isRunningOrder: runningNumber > 0,
      createdBy: req.userId,
      timerStart: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      taxRate: orderData.taxRate || 0,
      tax: orderData.tax || 0,
    });

    console.log('📦 Order taxRate before save:', order.taxRate);
    console.log('📦 Order tax before save:', order.tax);
    
    const savedOrder = await order.save();
    console.log(`✅ Order saved: ${displayOrderNumber} (ID: ${savedOrder._id})`);
    
    // Update table running order count after order is saved (only for additional orders)
    if (orderData.orderType === 'dine-in' && orderData.tableNumber && isAdditionalOrder) {
      const table = await Table.findOne({ tableNumber: orderData.tableNumber });
      if (table) {
        table.runningOrderCount = table.runningOrderCount + 1;
        await table.save();
        console.log(`Table ${orderData.tableNumber} running order count updated to ${table.runningOrderCount}`);
      }
    }
    
    const io = req.app.get('io');
    
    // Emit events
    if (io) {
      io.emit('new-order', savedOrder);
      io.emit('order-updated', savedOrder);
      io.emit('new-order-received', savedOrder);
      
      // Send push notification to kitchen staff
      await notifyKitchenNewOrder(savedOrder);
      
      if (orderData.orderType === 'dine-in' && orderData.tableNumber) {
        const updatedTable = await Table.findOne({ tableNumber: orderData.tableNumber });
        io.emit('table-status-changed', { 
          tableNumber: orderData.tableNumber, 
          status: 'running',
          runningOrderCount: updatedTable?.runningOrderCount || 1,
          baseOrderNumber: updatedTable?.baseOrderNumber
        });
      }
    }
    
    res.status(201).json(savedOrder);
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add item to order
router.post('/:id/items', authenticate, async (req, res) => {
  try {
    const { item } = req.body;
    
    if (!item || !item.id) {
      return res.status(400).json({ error: 'Item ID is required' });
    }
    
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const newItem = {
      id: item.id,
      name: item.name || 'Unknown Item',
      quantity: item.quantity || 1,
      price: item.price || 0,
      specialInstructions: item.specialInstructions || '',
      status: 'pending',
      isModified: true,
      isRemoved: false,
      modifiedAt: new Date(),
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      categorySortOrder: item.categorySortOrder || 999
    };
    
    const existingItem = order.items.find(i => i.id === newItem.id);
    if (existingItem) {
      existingItem.oldQuantity = existingItem.quantity;
      existingItem.quantity += newItem.quantity;
      existingItem.isModified = true;
      existingItem.modifiedAt = new Date();
    } else {
      order.items.push(newItem);
    }
    
    // Update totals
    order.subtotal = order.items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    order.tax = order.subtotal * (order.taxRate / 100);
    order.serviceCharge = order.subtotal * (order.serviceChargeRate / 100);
    order.total = order.subtotal + order.tax + order.serviceCharge;
    order.updatedAt = new Date();
    order.hasModifications = true;
    
    await order.save();
    
    const io = req.app.get('io');
    if (io) {
      io.emit('order-updated', order);
      io.emit('order-item-added', { orderId: order._id, item: newItem });
      io.emit('order-modified', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        displayOrderNumber: order.displayOrderNumber,
        tableNumber: order.tableNumber,
        isRunningOrder: order.isRunningOrder,
        itemId: newItem.id,
        newQuantity: newItem.quantity
      });
      
      // Send push notification to kitchen staff about modification
      await notifyKitchenOrderModified(order, order.isRunningOrder);
    }
    
    res.json(order);
  } catch (error) {
    console.error('Error adding item:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove item from order
router.delete('/:id/items/:itemId', authenticate, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const removedItem = order.items.find(i => i.id === req.params.itemId);
    
    order.items = order.items.filter(i => i.id !== req.params.itemId);
    
    // Update totals
    order.subtotal = order.items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    order.tax = order.subtotal * (order.taxRate / 100);
    order.serviceCharge = order.subtotal * (order.serviceChargeRate / 100);
    order.total = order.subtotal + order.tax + order.serviceCharge;
    order.updatedAt = new Date();
    order.hasModifications = true;
    
    await order.save();
    
    const io = req.app.get('io');
    if (io) {
      io.emit('order-updated', order);
      io.emit('order-item-removed', { orderId: order._id, itemId: req.params.itemId });
      io.emit('order-modified', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        displayOrderNumber: order.displayOrderNumber,
        tableNumber: order.tableNumber,
        isRunningOrder: order.isRunningOrder,
        removedItem: removedItem?.name
      });
      
      // Send push notification to kitchen staff about modification
      await notifyKitchenOrderModified(order, order.isRunningOrder);
    }
    
    res.json(order);
  } catch (error) {
    console.error('Error removing item:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update item quantity
router.patch('/:id/items/:itemId', authenticate, async (req, res) => {
  try {
    const { quantity } = req.body;
    
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const item = order.items.find(i => i.id === req.params.itemId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    const oldQuantity = item.quantity;
    item.oldQuantity = oldQuantity;
    item.quantity = quantity;
    item.isModified = true;
    item.modifiedAt = new Date();
    
    // Update totals
    order.subtotal = order.items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    order.tax = order.subtotal * (order.taxRate / 100);
    order.serviceCharge = order.subtotal * (order.serviceChargeRate / 100);
    order.total = order.subtotal + order.tax + order.serviceCharge;
    order.updatedAt = new Date();
    order.hasModifications = true;
    
    await order.save();
    
    const io = req.app.get('io');
    if (io) {
      io.emit('order-updated', order);
      io.emit('order-item-quantity-updated', { 
        orderId: order._id, 
        itemId: req.params.itemId, 
        oldQuantity, 
        newQuantity: quantity 
      });
      io.emit('order-modified', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        displayOrderNumber: order.displayOrderNumber,
        tableNumber: order.tableNumber,
        isRunningOrder: order.isRunningOrder,
        itemId: req.params.itemId,
        oldQuantity,
        newQuantity: quantity
      });
      
      // Send push notification to kitchen staff about modification
      await notifyKitchenOrderModified(order, order.isRunningOrder);
    }
    
    res.json(order);
  } catch (error) {
    console.error('Error updating quantity:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update order status
router.patch('/:id/status', authenticate, async (req, res) => {
  try {
    const { status, deliveryPlatform } = req.body;
    const updateData = { 
      status, 
      updatedAt: new Date() 
    };
    
    // If delivery platform is provided, update it
    if (deliveryPlatform !== undefined && deliveryPlatform !== null) {
      updateData.deliveryPlatform = deliveryPlatform;
    }
    
    if (status === 'completed') {
      updateData.completedAt = new Date();
      updateData.completedBy = req.userId;
    }
    
    if (status === 'accepted') {
      updateData.acceptedBy = req.userId;
    }
    
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const io = req.app.get('io');
    if (io) {
      io.emit('order-updated', order);
      if (status === 'accepted') io.emit('order-accepted', order._id);
      if (status === 'ready_for_billing') {
        io.emit('order-ready-for-billing', order._id);
        await notifyOrderReady(order);
      }
      if (status === 'completed') io.emit('order-completed', order._id);
      
      if ((status === 'cancelled' || status === 'completed') && order.tableNumber) {
        await updateTableStatusFromOrders(order.tableNumber, io);
      }
    }
    
    res.json(order);
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update item status
router.patch('/:id/items/:itemId/status', authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const item = order.items.find(i => i.id === req.params.itemId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    const oldStatus = item.status;
    item.status = status;
    if (status === 'completed') {
      item.completedAt = new Date();
    }
    
    await order.save();
    
    const io = req.app.get('io');
    if (io) {
      io.emit('order-updated', order);
      io.emit('item-status-updated', { orderId: order._id, itemId: req.params.itemId, status, oldStatus });
      
      if (status === 'completed' && oldStatus !== 'completed') {
        await notifyKitchenOrderModified(order, order.isRunningOrder);
      }
    }
    
    res.json(order);
  } catch (error) {
    console.error('Error updating item status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Complete payment - UPDATED with proper split payment handling
router.patch('/:id/complete-payment', authenticate, async (req, res) => {
  try {
    const { paymentMethod, paymentDetails, status, completedAt } = req.body;
    
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    console.log('Processing payment for order:', order.displayOrderNumber);
    console.log('Payment method:', paymentMethod);
    console.log('Payment details:', paymentDetails);
    
    // Handle split payment
    if (paymentMethod === 'split' && paymentDetails.splitDetails && paymentDetails.splitDetails.length > 0) {
      const splitDetails = paymentDetails.splitDetails;
      const totalAmount = paymentDetails.amount;
      
      // Create individual payment records for each split method
      const splitRecords = splitDetails.map(p => ({
        method: p.method,
        amount: p.amount,
        transactionId: paymentDetails.transactionId,
        timestamp: new Date()
      }));
      
      order.payment = {
        method: 'split',
        status: 'paid',
        amount: totalAmount,
        transactionId: paymentDetails.transactionId,
        timestamp: new Date(),
        splitDetails: splitRecords,
        note: `Split payment: ${splitRecords.map(s => `${s.method.toUpperCase()}: ₹${s.amount}`).join(', ')}`
      };
      
      console.log(`✅ Split payment processed: ${splitRecords.map(s => `${s.method}: ₹${s.amount}`).join(', ')}`);
    } 
    // Handle credit payment
    else if (paymentMethod === 'credit') {
      order.payment = {
        method: 'credit',
        status: 'credit_due',
        amount: paymentDetails.amount,
        transactionId: paymentDetails.transactionId || `CREDIT_${Date.now()}`,
        timestamp: new Date(),
        dueDate: paymentDetails.dueDate,
        customerName: paymentDetails.customerName,
        customerPhone: paymentDetails.customerPhone,
        customerId: paymentDetails.customerId,
        notes: paymentDetails.notes
      };
      console.log(`✅ Credit sale recorded for ${paymentDetails.customerName}: ₹${paymentDetails.amount}`);
    }
    // Handle regular payments (cash, card, upi)
    else {
      order.payment = {
        method: paymentMethod,
        status: 'paid',
        amount: paymentDetails.amount,
        transactionId: paymentDetails.transactionId || `${paymentMethod.toUpperCase()}_${Date.now()}`,
        timestamp: new Date(),
        gatewayCharges: paymentDetails.gatewayCharges || 0,
        change: paymentDetails.change || 0
      };
      console.log(`✅ ${paymentMethod.toUpperCase()} payment processed: ₹${paymentDetails.amount}`);
    }
    
    if (status) order.status = status;
    if (completedAt) order.completedAt = new Date(completedAt);
    order.completedBy = req.userId;
    order.updatedAt = new Date();
    
    await order.save();
    
    const io = req.app.get('io');
    if (io) {
      io.emit('order-updated', order);
      if (status === 'completed') io.emit('order-completed', order._id);
      
      if (order.tableNumber) {
        await updateTableStatusFromOrders(order.tableNumber, io);
      }
    }
    
    res.json(order);
  } catch (error) {
    console.error('Error completing payment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Complete billing for table (close all orders and reset table)
router.post('/table/:tableNumber/complete-billing', authenticate, async (req, res) => {
  try {
    const tableNumber = parseInt(req.params.tableNumber);
    
    const activeOrders = await Order.find({
      tableNumber: tableNumber,
      status: { $in: ['pending', 'accepted', 'preparing', 'hold', 'ready_for_billing'] },
      'payment.status': { $ne: 'paid' }
    });
    
    if (activeOrders.length === 0) {
      return res.status(404).json({ error: 'No active orders found for this table' });
    }
    
    // Complete all active orders
    for (const order of activeOrders) {
      order.status = 'completed';
      order.completedAt = new Date();
      order.completedBy = req.userId;
      order.payment.status = 'paid';
      await order.save();
    }
    
    // RESET TABLE - Clear session and base order number
    const table = await Table.findOne({ tableNumber: tableNumber });
    if (table) {
      table.status = 'available';
      table.currentSessionId = null;
      table.baseOrderNumber = null;
      table.runningOrderCount = 0;
      await table.save();
      console.log(`✅ Table ${tableNumber} reset to available, session cleared`);
    }
    
    const io = req.app.get('io');
    if (io) {
      io.emit('table-billing-completed', { tableNumber, orders: activeOrders });
      io.emit('table-status-changed', { 
        tableNumber, 
        status: 'available', 
        runningOrderCount: 0,
        reset: true 
      });
    }
    
    res.json({ 
      message: `Billing completed for table ${tableNumber}`,
      count: activeOrders.length,
      tableReset: true
    });
  } catch (error) {
    console.error('Error completing table billing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Credit sale
router.post('/:id/credit-sale', authenticate, async (req, res) => {
  try {
    const { customerName, customerPhone, customerEmail, dueDate, customerId } = req.body;
    
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    order.payment = {
      method: 'credit',
      status: 'credit_due',
      amount: order.total,
      transactionId: `CREDIT_${Date.now()}`,
      timestamp: new Date(),
      dueDate: dueDate ? new Date(dueDate) : null,
      customerName: customerName,
      customerPhone: customerPhone,
      customerId: customerId || customerName
    };
    
    order.status = 'completed';
    order.completedAt = new Date();
    order.completedBy = req.userId;
    order.customer = {
      name: customerName,
      phone: customerPhone,
      email: customerEmail || ''
    };
    
    await order.save();
    
    const io = req.app.get('io');
    if (io) {
      io.emit('order-updated', order);
      
      if (order.tableNumber) {
        await updateTableStatusFromOrders(order.tableNumber, io);
      }
    }
    
    res.json(order);
  } catch (error) {
    console.error('Error processing credit sale:', error);
    res.status(500).json({ error: error.message });
  }
});

// Request cancellation of an item from kitchen
router.post('/:id/items/:itemId/request-cancellation', authenticate, async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const item = order.items.find(i => i.id === req.params.itemId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    // Only allow cancellation request if item is not already completed or cancelled
    if (item.status === 'completed') {
      return res.status(400).json({ error: 'Cannot cancel completed items' });
    }
    
    if (item.status === 'cancelled') {
      return res.status(400).json({ error: 'Item already cancelled' });
    }
    
    item.cancellationRequested = true;
    item.cancellationRequestedAt = new Date();
    item.cancellationRequestedBy = req.userId;
    item.cancellationReason = reason || 'No reason provided';
    item.status = 'cancellation_requested';
    
    await order.save();
    
    const io = req.app.get('io');
    if (io) {
      io.emit('cancellation-requested', {
        orderId: order._id,
        itemId: item.id,
        itemName: item.name,
        quantity: item.quantity,
        reason: item.cancellationReason,
        orderNumber: order.displayOrderNumber || order.orderNumber,
        tableNumber: order.tableNumber,
        orderType: order.orderType,
        deliveryPlatform: order.deliveryPlatform,
        requestedAt: item.cancellationRequestedAt
      });
      
      // Send push notification for cancellation request
      await notifyCancellationRequest(order, item);
    }
    
    res.json({ message: 'Cancellation request sent', item });
  } catch (error) {
    console.error('Error requesting cancellation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Approve cancellation (Admin/POS)
router.post('/:id/items/:itemId/approve-cancellation', authenticate, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const itemIndex = order.items.findIndex(i => i.id === req.params.itemId);
    if (itemIndex === -1) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    const item = order.items[itemIndex];
    
    if (!item.cancellationRequested) {
      return res.status(400).json({ error: 'No cancellation request for this item' });
    }
    
    // Mark as cancelled and remove from order
    item.status = 'cancelled';
    item.isRemoved = true;
    item.removedAt = new Date();
    item.cancellationApproved = true;
    item.cancellationApprovedAt = new Date();
    item.cancellationApprovedBy = req.userId;
    
    // Remove the item from the items array
    order.items.splice(itemIndex, 1);
    
    // RECALCULATE ALL TOTALS
    order.subtotal = order.items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    order.tax = order.subtotal * (order.taxRate / 100);
    order.serviceCharge = order.subtotal * (order.serviceChargeRate / 100);
    order.total = order.subtotal + order.tax + order.serviceCharge;
    order.updatedAt = new Date();
    
    // If no items left, cancel the entire order
    if (order.items.length === 0) {
      order.status = 'cancelled';
      order.cancelledAt = new Date();
      order.cancelledBy = req.userId;
    }
    
    await order.save();
    
    console.log(`✅ Cancellation approved for item ${item.name}. New order total: ${order.total}`);
    
    const io = req.app.get('io');
    if (io) {
      io.emit('cancellation-approved', {
        orderId: order._id,
        itemId: item.id,
        itemName: item.name,
        orderNumber: order.displayOrderNumber || order.orderNumber
      });
      io.emit('order-updated', order);
    }
    
    res.json({ message: 'Cancellation approved', order });
  } catch (error) {
    console.error('Error approving cancellation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reject cancellation (Admin/POS)
router.post('/:id/items/:itemId/reject-cancellation', authenticate, async (req, res) => {
  try {
    const { rejectReason } = req.body;
    const order = await Order.findById(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const item = order.items.find(i => i.id === req.params.itemId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    if (!item.cancellationRequested) {
      return res.status(400).json({ error: 'No cancellation request for this item' });
    }
    
    // Reset the item status
    item.cancellationRequested = false;
    item.cancellationRequestedAt = null;
    item.cancellationRequestedBy = null;
    item.cancellationReason = '';
    item.status = 'pending';
    
    await order.save();
    
    const io = req.app.get('io');
    if (io) {
      io.emit('cancellation-rejected', {
        orderId: order._id,
        itemId: item.id,
        itemName: item.name,
        rejectReason: rejectReason || 'No reason provided',
        orderNumber: order.displayOrderNumber || order.orderNumber
      });
      io.emit('order-updated', order);
    }
    
    res.json({ message: 'Cancellation rejected', order });
  } catch (error) {
    console.error('Error rejecting cancellation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all pending cancellation requests
router.get('/cancellation-requests/pending', authenticate, async (req, res) => {
  try {
    const orders = await Order.find({
      'items.cancellationRequested': true,
      'items.cancellationApproved': false
    }).populate('items.cancellationRequestedBy', 'username');
    
    const pendingRequests = [];
    orders.forEach(order => {
      order.items.forEach(item => {
        if (item.cancellationRequested && !item.cancellationApproved) {
          pendingRequests.push({
            orderId: order._id,
            orderNumber: order.displayOrderNumber || order.orderNumber,
            itemId: item.id,
            itemName: item.name,
            quantity: item.quantity,
            reason: item.cancellationReason,
            requestedAt: item.cancellationRequestedAt,
            requestedBy: item.cancellationRequestedBy,
            tableNumber: order.tableNumber,
            orderType: order.orderType,
            deliveryPlatform: order.deliveryPlatform
          });
        }
      });
    });
    
    res.json(pendingRequests);
  } catch (error) {
    console.error('Error fetching pending cancellations:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

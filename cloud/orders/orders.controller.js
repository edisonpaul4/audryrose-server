const Mailgun = require('mailgun-js');
const mailgun = new Mailgun({ apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN });

const { OrdersModel } = require('./orders.model');
const { bigCommerce } = require('../gateways/big-commerce');


exports.OrdersController = new class OrdersController {
  constructor() { }

  /**
   * 
   * @returns {Promise} <ParseObject<Customer>>
   * @param {Number} customerId
   * @param {Boolean} json
   */
  getOrderById(orderId, json = false) {
    console.log('OrdersModel::getOrderById');
    return OrdersModel.getOrdersByFilters({
      equal: [{ key: 'orderId', value: orderId }]
    }).first().then(object => json ? object.toJSON() : object);
  } // END getOrderById

  /**
   * 
   * @param productId<Number>
   * @param filters<Object> - same values that model filters
   */
  getOrdersForProduct(productId, extraFilters = {}){
    return new Promise((resolve, reject) => {
      const filters = {
        contained: [
          { key: 'productIds', value: [parseInt(productId)]},
        ],
        ...extraFilters
      };
      OrdersModel.getOrdersByFilters(filters)
        .find()
        .then(orders => resolve(orders))
        .catch(error => reject(error))
    });
  } // END getOrdersForProduct

  /**
   * 
   * @returns {Promise} Array<Objects>
   */
  getOrdersToSendEmails(offset = 0) {
    const formatOrder = order => ({
      objectId: order.objectId,
      orderId: order.orderId,
      dateShipped: order.dateShipped,
      items_total: order.items_total,
      status_id: order.status_id,
      isEmailSended: order.isEmailSended,
      customerMessage: order.customer_message,
      staffNotes: order.staff_notes,
      internalNotes: order.internalNotes,
      designerNotes: order.designerNotes,
      orderProducts: order.orderProducts.map(orderProduct => ({
        objectId: orderProduct.objectId,
        productId: orderProduct.product_id,
        name: orderProduct.name,
        sku: orderProduct.sku,
        done: orderProduct.done,
        deleted: orderProduct.deleted,
        averageWaitTime: orderProduct.vendor ? orderProduct.vendor.get('waitTime') ? orderProduct.vendor.get('waitTime') : 21 : 21,
        designerId: orderProduct.designer ? orderProduct.designer.get('designerId') : undefined,
        awaitingInventoryVendorOrders: orderProduct.awaitingInventoryVendorOrders ? orderProduct.awaitingInventoryVendorOrders : [],
        awaitingInventory: orderProduct.awaitingInventory ? orderProduct.awaitingInventory : [],
        awaitingInventoryExpectedDate: orderProduct.awaitingInventoryExpectedDate ? orderProduct.awaitingInventoryExpectedDate.iso : undefined,
        quantity_shipped: orderProduct.quantity_shipped,
        quantity: orderProduct.quantity,
        totalInventory: orderProduct.totalInventory,
        isActive: orderProduct.isActive,
        classificationName: orderProduct.classificationName,
        product_options: orderProduct.product_options ? orderProduct.product_options.map(option => ({
          display_name: option.display_name,
          display_value: option.display_value,
        })) : []
      })),
      customer: {
        objectId: order.customer.objectId,
        firstName: order.customer.firstName,
        lastName: order.customer.lastName,
        totalOrders: order.customer.totalOrders,
        customerId: order.customer.customerId,
        totalSpend: order.customer.totalSpend,
      },
    });

    return OrdersModel.getCustomerOrdersForSendEmails()
      .then(orders => ({
        success: true,
        emailOrders: orders.map(order => formatOrder(order))
      }));
  } // END getOrdersForProduct


  /**
   * 
   * @param {Number} orderId 
   * @param {String} messages 
   */
  updateOrderNotes(orderId, { internalNotes, designerNotes }){
    console.log('OrdersController::updateOrderNotes')
    if(orderId === undefined || orderId === null)
      return Promise.reject({ message: 'You must especify the orderId' });
      
    const filters = {
      equal: [
        { key: 'orderId', value: orderId }
      ]
    };
    return OrdersModel.getOrdersByFilters(filters)
      .first()
      .then(orderObject => Promise.all(
        [OrdersModel.setInternalNotes(orderObject, internalNotes),
        OrdersModel.setDesignerNotes(orderObject, designerNotes)]
      ))
      .then(results => ({ order: results[1].toJSON() }));
  }
  
  /**
   * 
   * @returns {Promise}
   * @param {Number} orderId 
   * @param {Object} emailParams <{emailMessage: String, emailSubject: String}>
   */
  sendOrderEmail(orderId, emailParams) {
    console.log('OrdersController::sendOrderEmail');
    const getOrder = orderId => OrdersModel.getOrdersByFilters({
      includes: ['customer'],
      equal: [
        { key: 'orderId', value: orderId }
      ]
    }).first();

    const updatedIsEmailSended = orderObject => {
      return orderObject.set('isEmailSended', true)
        .save();
    }

    const sendEmailToCustomer = (order, emailParams) => {
      const data = {
        from: 'tracy@loveaudryrose.com',
        to: `${order.get('customer').get('firstName') + ' ' + order.get('customer').get('lastName')} <${process.env.NODE_ENV === 'production' ? order.get('billing_address').email : 'ejas94@gmail.com'}>`,
        cc: process.env.NODE_ENV === 'production' ? 'Audry Rose <tracy@loveaudryrose.com>' : 'Testing <arrieta.e@outlook.com>',
        subject: emailParams.emailSubject,
        text: emailParams.emailMessage,
      }
      console.log(data)
      //return mailgun.messages().send(data)
      //  .then(emailResult => ({
      //    emailResult,
      //    order
      //  }));
    }

    return getOrder(orderId)
      .then(order => sendEmailToCustomer(order, emailParams))
      .then(results => updatedIsEmailSended(results.order))
      .then(order => ({
        success: true,
        orderId
      }));
  }

  deleteOrderEmail(orderId) {
    console.log('OrdersController::deleteOrderEmail');
    const getOrder = orderId => OrdersModel.getOrdersByFilters({
      equal: [ { key: 'orderId', value: orderId } ]
    }).first();

    const setEmailAsSended = orderObject => {
      orderObject.set('isEmailSended', true);
      return orderObject.save();
    }

    return getOrder(orderId)
      .then(setEmailAsSended)
      .then(orderObject => ({
        success: true,
        orderId: orderObject.get('orderId')
      }))
  }
  
  

}
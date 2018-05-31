const { ProductsModel } = require('../products/products.model');
const { ReturnsModel } = require('../returns/returns.model');
const { OrdersModel } = require('../orders/orders.model');

var moment = require('moment-timezone');

exports.StatsController = new class StatsCrontroller {
  constructor() { }

  getProductStats() {
    console.log('entra');
    var productsOut;
    var response = ProductsModel.getProductsByFilters({
      limit: 10000
    }).find().then(products => {
      return OrdersModel.getOrderProductsByFilters(
        { limit: 10000,greaterOrEqual: [{ key: 'createdAt', value: moment('20180101').toDate() }] }).find().then(productOrders => {
          console.log('done order product')
          return ReturnsModel.getReturnsByFilters( { limit: 10000, greaterOrEqual: [{ key: 'createdAt', value: moment('20180101').toDate() }] }).find().then(productReturns =>{
            console.log('done return')
            return products.map(product => this.createProductStatsObject(product, productOrders, productReturns))
          })
        });
    });
    return response;
  }

  createProductStatsObject(productObject, productOrders, productReturns) {
    const unitsRepaired = typeof productObject.get('totalRepaired') !== 'undefined' ? productObject.get('totalRepaired') : 0;
    var countingSold =productOrders.filter(result => result.get('product_id') == productObject.get('productId')).length;
    var countingReturn = productReturns.filter(result => result.get('productId') == productObject.get('productId')).length;
    //productOrders.filter(result => result.get('product_id') == productObject.get('productId')).map(result => countingSold += result.get('quantity'))
    return {
      productId: productObject.get('productId'),
      productName: productObject.get('name'),
      totalSold: countingSold,
      unitsReturned: countingReturn,
      unitsReturnedP: countingSold !== 0 ? (countingReturn * 100) / countingSold : 0,
      unitsRepaired,
      unitsRepairedP: countingSold !== 0 ? (unitsRepaired * 100) / countingSold : 0,
      totalReveneu: productObject.get('price') * countingSold
    };


  }

}